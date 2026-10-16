import { describe, expect, it } from "vitest";
import { maybeStarted, OpsCrewError } from "./errors";

describe("maybeStarted", () => {
  it("says the purchase may have started and where to check before buying again", () => {
    const cause = new TypeError("socket hang up");
    const error = maybeStarted({
      registrar: "Porkbun",
      domain: "shop.example",
      detail: "the connection was lost",
      dashboard: "https://porkbun.com/account/domainsSpeedy",
      cause,
    });
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Porkbun gave no clear answer while registering shop.example (the connection was lost). The purchase may still have started; check its status before trying again.",
    );
    expect(error.hint).toBe(
      "Run `opscrew domain status` or look at https://porkbun.com/account/domainsSpeedy before buying shop.example again.",
    );
    expect(error.cause).toBe(cause);
  });
});
