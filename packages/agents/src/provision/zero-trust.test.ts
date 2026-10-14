import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { cloudflareZeroTrust } from "./zero-trust";

const TOKEN = fakeSecret("cloudflare-token", "zero-trust");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const NOT_ENABLED_BODY = {
  result: null,
  success: false,
  errors: [
    {
      code: 9999,
      message:
        "access.api.error.not_enabled: Access is not enabled. Visit the Access dashboard at https://dash.cloudflare.com/ and click the 'Enable Access' button.",
    },
  ],
  messages: [],
};

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lookup(fetch: FetchFn, env: Record<string, string | undefined> = {}) {
  const api = cloudflareZeroTrust({
    env: { CLOUDFLARE_API_TOKEN: TOKEN, ...env },
    fetch: fetch as typeof globalThis.fetch,
    redactor: new Redactor(),
    version: "0.0.0-test",
  });
  return api.organization(ACCOUNT);
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    return error as OpsCrewError;
  }
  throw new Error("expected the lookup to throw");
}

function expectNoToken(error: OpsCrewError): void {
  expect(error.message).not.toContain(TOKEN);
  expect(error.hint ?? "").not.toContain(TOKEN);
}

describe("cloudflareZeroTrust", () => {
  it("reads the organizations endpoint with the token", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const result = await lookup(async (input, init) => {
      seen = {
        url: String(input),
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return jsonResponse(200, {
        success: true,
        result: { auth_domain: "team.cloudflareaccess.com" },
      });
    });
    expect(result).toEqual({ authDomain: "team.cloudflareaccess.com" });
    expect(seen?.url).toContain(`/accounts/${ACCOUNT}/access/organizations`);
    expect(seen?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("says plainly that Access is not turned on (HTTP 403, error 9999)", async () => {
    const error = await caught(lookup(async () => jsonResponse(403, NOT_ENABLED_BODY)));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/Cloudflare Access is not turned on/);
    expect(error.message).toMatch(/SSH hostname/);
    expect(error.message).toMatch(/Portainer/);
    expect(error.message).toMatch(/Nothing was changed/);
    expect(error.hint).toContain("https://one.dash.cloudflare.com/");
    expect(error.hint).toMatch(/team name/);
    expect(error.hint).toMatch(/Free plan/);
    expect(error.hint).toMatch(/run the command again/);
    expect(error.hint).not.toMatch(/api-tokens/);
    expectNoToken(error);
  });

  it("recognizes the same error under another status", async () => {
    for (const status of [400, 404, 200, 500]) {
      const error = await caught(
        lookup(async () =>
          jsonResponse(status, {
            success: false,
            errors: [{ code: 9999, message: "ACCESS IS NOT ENABLED for this account" }],
          }),
        ),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
    }
  });

  it("keeps the missing-permission error for other 401/403 answers", async () => {
    for (const status of [401, 403]) {
      const error = await caught(
        lookup(async () =>
          jsonResponse(status, {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
        ),
      );
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.message).toMatch(/missing a permission/);
      expect(error.hint).toContain("https://dash.cloudflare.com/profile/api-tokens");
      expectNoToken(error);
    }
  });

  it("keeps the missing-permission error for a 403 whose body is not JSON", async () => {
    const error = await caught(lookup(async () => new Response("forbidden", { status: 403 })));
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });

  it("returns undefined on 404", async () => {
    expect(await lookup(async () => jsonResponse(404, { success: false }))).toBeUndefined();
  });

  it("returns undefined for a success with no organization", async () => {
    expect(await lookup(async () => jsonResponse(200, { success: true, result: null }))).toBe(
      undefined,
    );
  });

  it("fails closed on an organization without a team domain", async () => {
    const error = await caught(
      lookup(async () => jsonResponse(200, { success: true, result: { name: "team" } })),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expectNoToken(error);
  });

  it("reports a network error as PROVIDER_ERROR", async () => {
    const error = await caught(
      lookup(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/could not reach Cloudflare/);
    expectNoToken(error);
  });

  it("asks for the token when it is missing", async () => {
    let called = false;
    const error = await caught(
      lookup(
        async () => {
          called = true;
          return jsonResponse(200, { success: true, result: null });
        },
        { CLOUDFLARE_API_TOKEN: "  " },
      ),
    );
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(called).toBe(false);
  });

  it("never echoes the token, even when Cloudflare does", async () => {
    const error = await caught(
      lookup(async () =>
        jsonResponse(500, { success: false, errors: [{ message: `bad token ${TOKEN}` }] }),
      ),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expectNoToken(error);

    const notEnabled = await caught(
      lookup(async () =>
        jsonResponse(403, {
          success: false,
          errors: [{ message: `Access is not enabled (token ${TOKEN})` }],
        }),
      ),
    );
    expect(notEnabled.code).toBe("PHASE_PRECONDITION");
    expectNoToken(notEnabled);
  });
});
