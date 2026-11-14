import { describe, expect, it } from "vitest";
import {
  certificateCoversHost,
  checkHostName,
  durationText,
  escapeRegExp,
  formatMoney,
  isoDateOr,
  listText,
  lowerFirst,
  normalizeHostName,
  octalMode,
  orText,
  parentDomain,
  plural,
  taxLabel,
  upperFirst,
} from "./text";

describe("listText", () => {
  it("joins items as plain English", () => {
    expect(listText([])).toBe("");
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b"])).toBe("a and b");
    expect(listText(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("orText", () => {
  it("joins alternatives as plain English", () => {
    expect(orText([])).toBe("");
    expect(orText(["a"])).toBe("a");
    expect(orText(["a", "b"])).toBe("a or b");
    expect(orText(["a", "b", "c"])).toBe("a, b or c");
  });
});

describe("plural", () => {
  it("adds an s unless the count is 1", () => {
    expect(plural(0, "server")).toBe("0 servers");
    expect(plural(1, "server")).toBe("1 server");
    expect(plural(2, "server")).toBe("2 servers");
  });
});

describe("normalizeHostName", () => {
  it("trims, lower-cases and drops one trailing dot", () => {
    expect(normalizeHostName("  App.Example.COM. ")).toBe("app.example.com");
    expect(normalizeHostName("example.com")).toBe("example.com");
  });
});

describe("checkHostName", () => {
  it("answers a hostname normalized, and refuses anything else", () => {
    expect(checkHostName(" App.Example.com. ")).toBe("app.example.com");
    for (const name of ["example", "-a.example.com", "a..example.com", "a_b.example.com"]) {
      expect(() => checkHostName(name)).toThrow(`"${name}" isn't a hostname.`);
    }
  });
});

describe("parentDomain", () => {
  it("answers the longest domain the name sits under, as given", () => {
    const domains = ["example.com", "Shop.Example.com", "other.org"];
    expect(parentDomain("app.shop.example.com", domains)).toBe("Shop.Example.com");
    expect(parentDomain("app.example.com", domains)).toBe("example.com");
    expect(parentDomain("example.com", domains)).toBeUndefined();
    expect(parentDomain("app.example.net", domains)).toBeUndefined();
  });
});

describe("certificateCoversHost", () => {
  it("matches exact names and single-label wildcards", () => {
    expect(certificateCoversHost("shop.example.com", ["SHOP.example.com."])).toBe(true);
    expect(certificateCoversHost("shop.example.com", ["*.example.com"])).toBe(true);
    expect(certificateCoversHost("a.shop.example.com", ["*.example.com"])).toBe(false);
    expect(certificateCoversHost("example.com", ["*.example.com"])).toBe(false);
    expect(certificateCoversHost("shop.example.com", ["example.com"])).toBe(false);
  });
});

describe("octalMode", () => {
  it("gives four octal digits, and refuses what isn't a mode", () => {
    expect(octalMode(0o600)).toBe("0600");
    expect(octalMode(0o44)).toBe("0044");
    for (const mode of [-1, 0o1000, 1.5])
      expect(() => octalMode(mode)).toThrow("isn't a file mode");
  });
});

describe("durationText", () => {
  it("says whole minutes for a whole number of minutes", () => {
    expect(durationText(60_000)).toBe("1 minute");
    expect(durationText(15 * 60_000)).toBe("15 minutes");
    expect(durationText(60 * 60_000)).toBe("60 minutes");
    expect(durationText(150 * 60_000)).toBe("150 minutes");
  });

  it("says whole hours for a whole number of hours from two hours on", () => {
    expect(durationText(2 * 3_600_000)).toBe("2 hours");
    expect(durationText(6 * 3_600_000)).toBe("6 hours");
  });

  it("says whole seconds otherwise", () => {
    expect(durationText(1_000)).toBe("1 second");
    expect(durationText(9_000)).toBe("9 seconds");
    expect(durationText(90_000)).toBe("90 seconds");
    expect(durationText(1_400)).toBe("1 second");
    expect(durationText(1_600)).toBe("2 seconds");
  });
});

describe("taxLabel", () => {
  it("names VAT for euro prices and tax for dollar prices", () => {
    expect(taxLabel("EUR", true)).toBe("incl. VAT");
    expect(taxLabel("EUR", false)).toBe("excl. VAT");
    expect(taxLabel("USD", true)).toBe("incl. tax");
    expect(taxLabel("USD", false)).toBe("excl. tax");
  });
});

describe("formatMoney", () => {
  it("puts the currency's symbol before the amount with two decimals", () => {
    expect(formatMoney({ amount: 6.09, currency: "EUR" })).toBe("€6.09");
    expect(formatMoney({ amount: 6.7, currency: "USD" })).toBe("$6.70");
  });
});

describe("lowerFirst and upperFirst", () => {
  it("change only the first character", () => {
    expect(lowerFirst("Run it Again")).toBe("run it Again");
    expect(upperFirst("run it again")).toBe("Run it again");
    expect(lowerFirst("")).toBe("");
    expect(upperFirst("")).toBe("");
  });
});

describe("escapeRegExp", () => {
  it("escapes every metacharacter but /, so a pattern matches the text literally", () => {
    const text = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p";
    expect(escapeRegExp(text)).toBe("a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o/p");
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
  });
});

describe("isoDateOr", () => {
  it("writes a date as ISO 8601 in UTC", () => {
    expect(isoDateOr("2026-10-13T12:00:00+02:00")).toBe("2026-10-13T10:00:00.000Z");
  });

  it("keeps text that is not a date as it is", () => {
    expect(isoDateOr("soon")).toBe("soon");
  });
});
