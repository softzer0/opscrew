import { expect, describe as group, it } from "vitest";
import { NAMECHEAP_DASHBOARD_URLS, namecheapError } from "./errors";

const base = { urls: NAMECHEAP_DASHBOARD_URLS, scrub: (text: string) => text };

group("namecheapError", () => {
  it("names the domain in the connect command after a premium or extended-attribute refusal", () => {
    for (const number of ["2515623", "2011322", "2030280"]) {
      const error = namecheapError([{ number, text: "Cannot register this domain." }], {
        ...base,
        what: "register shopapp.com",
        suffix: "Nothing was bought.",
      });
      expect(error.hint, number).toBe(
        `Buy it in the Namecheap dashboard at ${NAMECHEAP_DASHBOARD_URLS.domainList}, then run \`opscrew domain connect shopapp.com\`.`,
      );
    }
  });

  it("falls back to a placeholder when the call names no single domain", () => {
    const error = namecheapError([{ number: "2515623", text: "Premium." }], {
      ...base,
      what: "check a.com and b.net",
    });
    expect(error.hint).toContain("`opscrew domain connect <domain>`");
  });
});
