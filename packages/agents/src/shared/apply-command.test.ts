import { describe, expect, it } from "vitest";
import { exactBuyCommand } from "../domain/purchase";
import { applyCommand, pathWord, shellWord, stackFollowsReason } from "./apply-command";

describe("stackFollowsReason", () => {
  const hash = "a".repeat(64);

  it("says why the stack plan follows: the bucket, then the origin certificate, then the tunnel's token", () => {
    const origin = { stackFollowsOriginTls: true as const };
    const certificate =
      "this Cloudflare plan is applied, because the stack's Caddy needs the origin certificate it creates";
    expect(stackFollowsReason({ storagePlanHash: hash, ...origin }, true)).toBe(
      "the app's bucket exists, because the app's stack gets the bucket's key",
    );
    // Provision sets the flag only when the stack plan waits for no tunnel: an infrastructure plan
    // beside it changes something else.
    expect(stackFollowsReason(origin, true)).toBe(certificate);
    expect(stackFollowsReason(origin, false)).toBe(certificate);
    expect(stackFollowsReason({}, true)).toBe(
      "this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token",
    );
  });

  it("gives none when the stack plan came with the plans, or nothing makes it wait", () => {
    expect(stackFollowsReason({ stackPlanHash: hash, stackFollowsOriginTls: true }, true)).toBe(
      undefined,
    );
    expect(stackFollowsReason({}, false)).toBeUndefined();
  });
});

describe("applyCommand", () => {
  it("repeats --key-out with the file the planning run named", () => {
    const hash = "a".repeat(64);
    expect(applyCommand("provision", [hash], { yes: true, keyOut: "/home/me/age key.txt" })).toBe(
      `opscrew provision --approve ${hash} --yes --key-out '/home/me/age key.txt'`,
    );
    expect(applyCommand("provision", [hash])).toBe(`opscrew provision --approve ${hash}`);
  });
});

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
