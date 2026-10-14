import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { cloudflareAccessLoginMethods, oneTimePinIdentityProvider } from "./access";

const api = (id: string | undefined) => {
  const asked: string[] = [];
  return {
    asked,
    oneTimePin: async (accountId: string) => {
      asked.push(accountId);
      return id;
    },
  };
};

describe("oneTimePinIdentityProvider", () => {
  it("keeps the login method the last render named", async () => {
    const lookup = api("other");
    expect(
      await oneTimePinIdentityProvider({
        previous: {
          one_time_pin_identity_provider_id: "pin-1",
          portainer_hostname: "p.example.com",
        },
        accountId: "acct",
        api: lookup,
      }),
    ).toBe("pin-1");
    expect(lookup.asked).toEqual([]);
  });

  it("leaves it unset when OpsCrew's own is already in the state (a subdomain without an id)", async () => {
    const lookup = api("pin-ours");
    expect(
      await oneTimePinIdentityProvider({
        previous: { portainer_hostname: "p.example.com" },
        accountId: "acct",
        api: lookup,
      }),
    ).toBeUndefined();
    expect(lookup.asked).toEqual([]);
  });

  it("reuses the account's existing one the first time, or lets OpsCrew create one", async () => {
    expect(
      await oneTimePinIdentityProvider({ previous: {}, accountId: "acct", api: api("pin-2") }),
    ).toBe("pin-2");
    expect(
      await oneTimePinIdentityProvider({
        previous: undefined,
        accountId: "acct",
        api: api(undefined),
      }),
    ).toBeUndefined();
  });
});

describe("cloudflareAccessLoginMethods", () => {
  it("finds the one-time PIN method and never puts the token in errors", async () => {
    const token = fakeSecret("cloudflare-token");
    const calls: string[] = [];
    let status = 200;
    const deps = await createTestPhaseDeps({
      env: { CLOUDFLARE_API_TOKEN: token },
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify(
            status === 200
              ? {
                  success: true,
                  result: [
                    { id: "gh-1", type: "github" },
                    { id: "pin-9", type: "onetimepin" },
                  ],
                }
              : { success: false, errors: [{ message: `bad token ${token}` }] },
          ),
          { status },
        );
      },
    });
    const methods = cloudflareAccessLoginMethods(deps);
    expect(await methods.oneTimePin("acct 1")).toBe("pin-9");
    expect(calls[0]).toContain("/accounts/acct%201/access/identity_providers");

    status = 500;
    const error = await methods.oneTimePin("acct").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).not.toContain(token);

    status = 403;
    expect(((await methods.oneTimePin("acct").catch((e) => e)) as OpsCrewError).code).toBe(
      "CREDENTIALS_INVALID",
    );
  });
});
