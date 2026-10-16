import { describe, expect, it } from "vitest";
import { exactBuyCommand } from "../domain/purchase";
import { shellWord } from "./apply-command";

describe("shellWord", () => {
  it("leaves plain words as they are and single-quotes anything a shell would change", () => {
    expect(shellWord("acc-1")).toBe("acc-1");
    expect(shellWord("dns/zones/example.com.txt")).toBe("dns/zones/example.com.txt");
    expect(shellWord("a_b=c,d%e+f@g:h")).toBe("a_b=c,d%e+f@g:h");
    expect(shellWord("Shop Team")).toBe("'Shop Team'");
    expect(shellWord("zones/$HOME.txt")).toBe("'zones/$HOME.txt'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });
});

describe("exactBuyCommand", () => {
  it("quotes --account like every other command OpsCrew suggests", () => {
    const command = exactBuyCommand(
      { domain: "shopapp.com", registrarId: "cloudflare" },
      {
        years: 1,
        autoRenew: true,
        account: " Shop Team ",
        quote: { charge: { amount: 10.44, currency: "USD" }, exact: true },
      },
    );
    expect(command).toBe(
      "opscrew domain buy shopapp.com --account 'Shop Team' --confirm shopapp.com --max-price 10.44USD",
    );
  });
});
