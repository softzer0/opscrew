import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { s3Client } from "./s3";

const KEY = {
  accessKeyId: fakeSecret("aws-access-key-id", "s3"),
  secretAccessKey: fakeSecret("aws-secret-access-key", "s3"),
};
const BUCKET = { endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1", bucket: "shop" };
const NOW = () => new Date("2026-10-20T08:09:10.123Z");

function answering(...statuses: (number | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = statuses.shift() ?? 404;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  return { fetch, calls };
}

describe("s3Client", () => {
  it("signs a path-style HEAD with SigV4 for the bucket's region", async () => {
    const { fetch, calls } = answering(200, 404);
    const client = s3Client(BUCKET, KEY, { fetch, now: NOW });
    expect(await client.headBucket()).toBe(true);
    expect(await client.headBucket()).toBe(false);
    const [call] = calls;
    expect(call?.url).toBe("https://fsn1.your-objectstorage.com/shop");
    expect(call?.init?.method).toBe("HEAD");
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("x-amz-date")).toBe("20261020T080910Z");
    expect(headers.get("x-amz-content-sha256")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.get("authorization")).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${KEY.accessKeyId}/20261020/fsn1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
      ),
    );
    expect(headers.get("authorization")).not.toContain(KEY.secretAccessKey);
  });

  it("signs differently for another secret, method or time", async () => {
    const signature = async (key: typeof KEY, method: "head" | "delete", now: () => Date = NOW) => {
      const { fetch, calls } = answering(204);
      const client = s3Client(BUCKET, key, { fetch, now });
      await (method === "head"
        ? client.headBucket().catch(() => undefined)
        : client.deleteBucket());
      return new Headers(calls[0]?.init?.headers).get("authorization")?.split("Signature=")[1];
    };
    const base = await signature(KEY, "head");
    expect(await signature(KEY, "head")).toBe(base);
    const other = { ...KEY, secretAccessKey: fakeSecret("aws-secret-access-key", "other") };
    expect(await signature(other, "head")).not.toBe(base);
    expect(await signature(KEY, "delete")).not.toBe(base);
    expect(await signature(KEY, "head", () => new Date("2026-10-20T08:09:11Z"))).not.toBe(base);
  });

  it("deletes the bucket, and one already gone is no error", async () => {
    const { fetch, calls } = answering(204, 404);
    const client = s3Client(BUCKET, KEY, { fetch, now: NOW });
    await client.deleteBucket();
    await client.deleteBucket();
    expect(calls.map((c) => c.init?.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("says plainly what failed, never with the key", async () => {
    const refused = answering(403, 409, new Error("getaddrinfo ENOTFOUND"));
    const client = s3Client(BUCKET, KEY, { fetch: refused.fetch, now: NOW });
    const forbidden = await client.headBucket().catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(OpsCrewError);
    expect(forbidden).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "fsn1.your-objectstorage.com answered HTTP 403 when OpsCrew tried to check the bucket shop.",
      hint: expect.stringContaining("bucket's key"),
    });
    await expect(client.deleteBucket()).rejects.toMatchObject({
      message:
        "fsn1.your-objectstorage.com answered HTTP 409 when OpsCrew tried to delete the bucket shop.",
    });
    const unreachable = await client.headBucket().catch((e: unknown) => e);
    expect(unreachable).toMatchObject({
      message: "Could not reach fsn1.your-objectstorage.com to check the bucket shop.",
    });
    for (const error of [forbidden, unreachable]) {
      const text = `${(error as OpsCrewError).message} ${(error as OpsCrewError).hint}`;
      expect(text).not.toContain(KEY.secretAccessKey);
      expect(text).not.toContain(KEY.accessKeyId);
    }
  });
});
