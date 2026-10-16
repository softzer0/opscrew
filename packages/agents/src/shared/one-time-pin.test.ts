import { describe, expect, it } from "vitest";
import { oneTimePinIdentityProvider } from "./one-time-pin";

/** Cloudflare's Access login methods: a GitHub login and, when given, a one-time PIN. */
const api = (id: string | undefined) => {
  const asked: string[] = [];
  return {
    asked,
    accessIdentityProviders: async (accountId: string) => {
      asked.push(accountId);
      return [
        { id: "gh-1", type: "github" },
        ...(id === undefined ? [] : [{ id, type: "onetimepin" }]),
      ];
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
    const lookup = api("pin-2");
    expect(await oneTimePinIdentityProvider({ previous: {}, accountId: "acct", api: lookup })).toBe(
      "pin-2",
    );
    expect(lookup.asked).toEqual(["acct"]);
    expect(
      await oneTimePinIdentityProvider({
        previous: undefined,
        accountId: "acct",
        api: api(undefined),
      }),
    ).toBeUndefined();
  });
});
