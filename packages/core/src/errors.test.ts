import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkRegistrationYears,
  connectAfterBuyingHint,
  errorMessage,
  errorText,
  maybeStarted,
  modelOutputMismatch,
  OpsCrewError,
} from "./errors";

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

describe("checkRegistrationYears", () => {
  it("accepts whole numbers from 1 to 10", () => {
    for (const years of [1, 5, 10]) expect(() => checkRegistrationYears(years)).not.toThrow();
  });

  it("refuses anything else plainly", () => {
    for (const years of [0, 11, 1.5, Number.NaN]) {
      const error = (() => {
        try {
          checkRegistrationYears(years);
        } catch (caught) {
          return caught;
        }
      })() as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(`A domain can be registered for 1 to 10 years, not ${years}.`);
      expect(error.hint).toBe("Pass a whole number of years between 1 and 10.");
    }
  });
});

describe("connectAfterBuyingHint", () => {
  it("says where to buy the domain and how to connect it then", () => {
    expect(connectAfterBuyingHint("at https://dcc.godaddy.com/domains", "shop.example")).toBe(
      "Buy it at https://dcc.godaddy.com/domains, then run `opscrew domain connect shop.example`.",
    );
  });
});

describe("errorMessage", () => {
  it("is an error's message, or the value as text", () => {
    expect(errorMessage(new Error("disk full"))).toBe("disk full");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("errorText", () => {
  it("joins a user-facing error's message and hint", () => {
    const error = new OpsCrewError("PROVIDER_ERROR", "It failed.", { hint: "Try again." });
    expect(errorText(error)).toBe("It failed. Try again.");
    expect(errorText(new OpsCrewError("INTERNAL", "No hint."))).toBe("No hint.");
    expect(errorText(error, "Could not check it.")).toBe("It failed. Try again.");
  });

  it("uses the fallback, else the message, for any other error", () => {
    expect(errorText(new Error("socket hang up"))).toBe("socket hang up");
    expect(errorText(new Error("socket hang up"), "Could not check it.")).toBe(
      "Could not check it.",
    );
  });
});

describe("modelOutputMismatch", () => {
  it("names the format and the first five problems", () => {
    const Schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });
    const error = Schema.safeParse({ a: 1, b: 1, c: 1, d: 1 }).error as z.ZodError;
    expect(modelOutputMismatch("ProjectFacts", error)).toBe(
      "The model's output did not match the expected ProjectFacts format (a: Invalid input: expected string, received number; b: Invalid input: expected string, received number; c: Invalid input: expected string, received number; d: Invalid input: expected string, received number).",
    );
  });
});
