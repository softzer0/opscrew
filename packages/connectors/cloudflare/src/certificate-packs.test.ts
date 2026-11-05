import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API, CloudflareClient, CloudflareError } from "./client";

const TOKEN = fakeSecret("cloudflare-token");

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, errors: { code?: number; message: string }[]) => ({
  status,
  body: { success: false, errors, messages: [], result: null },
});

const client = (routes: Record<string, FakeReply | FakeReply[]>) => {
  const fake = coreFakeFetch(routes, { base: CLOUDFLARE_API });
  return {
    ...fake,
    cf: new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} }),
  };
};

const QUOTA = "/zones/z1/ssl/certificate_packs/quota";
const TOTAL_TLS = "/zones/z1/acm/total_tls";
const PACKS = "/zones/z1/ssl/certificate_packs";

describe("CloudflareClient certificate pack calls", () => {
  it("reads the advanced certificate pack quota", async () => {
    const { cf, calls } = client({
      [QUOTA]: ok({ advanced: { allocated: 10, used: 1, extra: true }, other: 1 }),
    });
    expect(await cf.certificatePackQuota("z1")).toEqual({ allocated: 10, used: 1 });
    expect(calls[0]).toMatchObject({ method: "GET", path: QUOTA });
  });

  it("gives a quota of 0 and 0 when the answer has no advanced packs", async () => {
    const { cf } = client({ [QUOTA]: ok({}) });
    expect(await cf.certificatePackQuota("z1")).toEqual({ allocated: 0, used: 0 });
  });

  it("reads whether Total TLS is on", async () => {
    const { cf, calls } = client({
      [TOTAL_TLS]: [
        ok({ enabled: true, certificate_authority: "google", validity_period: 90 }),
        ok({ enabled: false }),
      ],
    });
    expect(await cf.totalTls("z1")).toEqual({ enabled: true });
    expect(await cf.totalTls("z1")).toEqual({ enabled: false });
    expect(calls[0]).toMatchObject({ method: "GET", path: TOTAL_TLS });
  });

  it("lists every certificate pack of the zone across pages, whatever its status", async () => {
    const hosts = ["example.com", "*.previews.example.com"];
    const pack = (id: string, type: string, status: string) => ({
      id,
      type,
      hosts,
      status,
      certificate_authority: "lets_encrypt",
      certificates: [],
    });
    const { cf, calls } = client({
      [`${PACKS}?page=1`]: ok([pack("p1", "universal", "active")], {
        result_info: { page: 1, total_pages: 2 },
      }),
      [`${PACKS}?page=2`]: ok([pack("p2", "advanced", "pending_validation")], {
        result_info: { page: 2, total_pages: 2 },
      }),
    });
    expect(await cf.listCertificatePacks("z1")).toEqual([
      { id: "p1", type: "universal", hosts, status: "active" },
      { id: "p2", type: "advanced", hosts, status: "pending_validation" },
    ]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("status")).toBe("all");
  });

  it.each<[string, (cf: CloudflareClient) => Promise<unknown>, string]>([
    ["certificatePackQuota", (cf) => cf.certificatePackQuota("z1"), QUOTA],
    ["totalTls", (cf) => cf.totalTls("z1"), TOTAL_TLS],
    ["listCertificatePacks", (cf) => cf.listCertificatePacks("z1"), PACKS],
  ])(
    "gives a refused %s (HTTP 403) the read permission to add, without the token",
    async (_, call, route) => {
      const { cf } = client({
        [route]: fail(403, [{ code: 10000, message: "Authentication error" }]),
      });
      const error = (await call(cf).catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("Zone → SSL and Certificates → Read");
      expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
    },
  );

  it("refuses an answer of an unexpected shape, naming the call", async () => {
    const { cf } = client({
      [QUOTA]: ok({ advanced: { allocated: "ten", used: 0 } }),
      [TOTAL_TLS]: ok({ enabled: "on" }),
      [PACKS]: ok([{ id: "p1", type: "advanced", status: "active" }]),
    });
    await expect(cf.certificatePackQuota("z1")).rejects.toMatchObject({
      message: expect.stringContaining("certificate pack quota"),
    });
    await expect(cf.totalTls("z1")).rejects.toMatchObject({
      message: expect.stringContaining("Total TLS"),
    });
    await expect(cf.listCertificatePacks("z1")).rejects.toMatchObject({
      message: expect.stringContaining("certificate packs"),
    });
  });
});
