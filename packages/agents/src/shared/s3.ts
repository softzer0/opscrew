import { createHash, createHmac } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { StorageLogin } from "./app-env";

/** A bucket at an S3-compatible service, addressed path-style (`<endpoint>/<bucket>`). */
export interface S3Bucket {
  /** The service's endpoint, for example `https://fsn1.your-objectstorage.com`. */
  endpoint: string;
  /** The region requests are signed for. */
  region: string;
  bucket: string;
}

/** The two bucket calls OpsCrew makes itself; everything else goes through the IaC engine. */
export interface S3Client {
  /** True while the bucket answers (HTTP 200), false once it is gone (404). */
  headBucket(): Promise<boolean>;
  /** Deletes the (empty) bucket; one already gone is no error. */
  deleteBucket(): Promise<void>;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date";

const hmac = (key: string | Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest();

/** The AWS Signature Version 4 headers of a body-less request to `url`. */
function signedHeaders(
  method: string,
  url: URL,
  region: string,
  key: Pick<StorageLogin, "accessKeyId" | "secretAccessKey">,
  now: Date,
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const canonical = [
    method,
    url.pathname,
    "",
    `host:${url.host}`,
    `x-amz-content-sha256:${EMPTY_SHA256}`,
    `x-amz-date:${amzDate}`,
    "",
    SIGNED_HEADERS,
    EMPTY_SHA256,
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let signingKey = hmac(`AWS4${key.secretAccessKey}`, day);
  for (const part of [region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return {
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
  };
}

/**
 * A minimal S3 client for one bucket, signed with the user's key (SigV4, no SDK). Errors name the
 * bucket, the host and the HTTP status, never the key.
 */
export function s3Client(
  target: S3Bucket,
  key: Pick<StorageLogin, "accessKeyId" | "secretAccessKey">,
  io: { fetch: FetchLike; now: () => Date },
): S3Client {
  const url = new URL(`${target.endpoint.replace(/\/+$/, "")}/${target.bucket}`);
  const request = async (method: "HEAD" | "DELETE", what: string): Promise<number> => {
    let response: Response;
    try {
      response = await io.fetch(url, {
        method,
        headers: signedHeaders(method, url, target.region, key, io.now()),
      });
    } catch (error) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Could not reach ${url.host} to ${what} the bucket ${target.bucket}.`,
        { hint: "Check your network connection, then try again.", cause: error },
      );
    }
    await response.body?.cancel();
    return response.status;
  };
  const refused = (status: number, what: string) =>
    new OpsCrewError(
      "PROVIDER_ERROR",
      `${url.host} answered HTTP ${status} when OpsCrew tried to ${what} the bucket ${target.bucket}.`,
      {
        hint:
          status === 403
            ? "Check that the bucket's key is still valid and may manage the bucket, then try again."
            : "Try again in a few minutes.",
      },
    );
  return {
    async headBucket() {
      const status = await request("HEAD", "check");
      if (status === 200) return true;
      if (status === 404) return false;
      throw refused(status, "check");
    },
    async deleteBucket() {
      const status = await request("DELETE", "delete");
      if (status === 204 || status === 200 || status === 404) return;
      throw refused(status, "delete");
    },
  };
}
