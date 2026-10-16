import { describe, expect, it } from "vitest";
import { exactBuyCommand } from "../domain/purchase";
import { pathWord, shellWord } from "./apply-command";

describe("shellWord", () => {
  it("leaves plain words as they are and single-quotes anything a shell would change", () => {
    expect(shellWord("acc-1")).toBe("acc-1");
    expect(shellWord("dns/zones/example.com.txt")).toBe("dns/zones/example.com.txt");
    expect(shellWord("a_b+c@d:e")).toBe("a_b+c@d:e");
    expect(shellWord("Shop Team")).toBe("'Shop Team'");
    expect(shellWord("zones/$HOME.txt")).toBe("'zones/$HOME.txt'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });

  it("quotes %, = and , too: PowerShell splits a,b into two words", () => {
    expect(shellWord("a,b")).toBe("'a,b'");
    expect(shellWord("key=value")).toBe("'key=value'");
    expect(shellWord("100%")).toBe("'100%'");
  });
});

describe("pathWord", () => {
  it("prints paths with / and single-quotes anything a shell would change", () => {
    expect(pathWord("zone.txt")).toBe("zone.txt");
    expect(pathWord("dns\\zones\\example.com.txt")).toBe("dns/zones/example.com.txt");
    expect(pathWord("my zones/example.txt")).toBe("'my zones/example.txt'");
    expect(pathWord("zones/$HOME.txt")).toBe("'zones/$HOME.txt'");
    expect(pathWord("it's.txt")).toBe("'it'\\''s.txt'");
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
