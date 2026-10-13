import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mapRegistrarRecord } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { parseBindZone, readBindFile } from "./connect-bind";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/connect-example.zone", import.meta.url));

function parseError(text: string, domain = "example.com"): OpsCrewError {
  try {
    parseBindZone(text, domain, "zone.txt");
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    return error as OpsCrewError;
  }
  throw new Error("expected a parse error");
}

describe("parseBindZone", () => {
  it("reads the exported zone: directives, @, relative names, blank owners, TTL and class, parentheses, quotes", async () => {
    const text = await readFile(FIXTURE, "utf8");

    const records = parseBindZone(text, "example.com", "connect-example.zone");

    expect(records).toEqual([
      {
        type: "SOA",
        name: "example.com",
        content: "ns1.example.net hostmaster.example.com 2026101301 7200 3600 1209600 300",
        ttl: 3600,
      },
      { type: "NS", name: "example.com", content: "ns1.example.net", ttl: 3600 },
      { type: "NS", name: "example.com", content: "ns2.example.net", ttl: 3600 },
      { type: "A", name: "example.com", content: "192.0.2.10", ttl: 300 },
      { type: "AAAA", name: "example.com", content: "2001:db8::10", ttl: 3600 },
      { type: "CNAME", name: "www.example.com", content: "example.com", ttl: 3600 },
      { type: "A", name: "api.example.com", content: "198.51.100.7", ttl: 600 },
      { type: "CNAME", name: "blog.example.com", content: "hosting.example.net", ttl: 3600 },
      { type: "MX", name: "example.com", content: "mail.example.com", priority: 10, ttl: 3600 },
      {
        type: "MX",
        name: "example.com",
        content: "backup-mx.example.net",
        priority: 20,
        ttl: 3600,
      },
      { type: "A", name: "mail.example.com", content: "203.0.113.25", ttl: 3600 },
      {
        type: "TXT",
        name: "example.com",
        content: '"v=spf1 include:_spf.example.net ~all"',
        ttl: 3600,
      },
      {
        type: "TXT",
        name: "_dmarc.example.com",
        content: '"v=DMARC1; p=none; " "rua=mailto:reports@example.com"',
        ttl: 3600,
      },
      {
        type: "TXT",
        name: "note.example.com",
        content: '"say \\"hi\\"; not a comment"',
        ttl: 3600,
      },
      {
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: "60 5060 sip.example.com",
        priority: 10,
        ttl: 3600,
      },
      { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"', ttl: 3600 },
    ]);
  });

  it("uses the connected domain as the origin when the file has no $ORIGIN", () => {
    const records = parseBindZone(
      ["@ A 192.0.2.1", "www 300 CNAME @", "shop.example.com. A 192.0.2.2"].join("\n"),
      "example.com",
      "zone.txt",
    );

    expect(records).toEqual([
      { type: "A", name: "example.com", content: "192.0.2.1" },
      { type: "CNAME", name: "www.example.com", content: "example.com", ttl: 300 },
      { type: "A", name: "shop.example.com", content: "192.0.2.2" },
    ]);
  });

  it("accepts class before TTL, TTL units, CRLF line ends and a relative $ORIGIN", () => {
    const records = parseBindZone(
      [
        "$TTL 1h",
        "$ORIGIN sub",
        "@ IN 1d A 192.0.2.3",
        "api A 192.0.2.4",
        "$ORIGIN example.com.",
        "*.dev 2h30m IN TXT unquoted-value",
      ].join("\r\n"),
      "example.com",
      "zone.txt",
    );

    expect(records).toEqual([
      { type: "A", name: "sub.example.com", content: "192.0.2.3", ttl: 86400 },
      { type: "A", name: "api.sub.example.com", content: "192.0.2.4", ttl: 3600 },
      { type: "TXT", name: "*.dev.example.com", content: '"unquoted-value"', ttl: 9000 },
    ]);
  });

  it("keeps other record types with their data, for the copy plan to list", () => {
    const records = parseBindZone(
      [
        "@ ALIAS hosting.example.net.",
        "_443._tcp TLSA 3 1 1 ABCDEF",
        "@ 3600 IN RRSIG A 13 2 3600 20261101000000 20261001000000 2371 example.com. c2lnbmF0dXJl",
      ].join("\n"),
      "example.com",
      "zone.txt",
    );

    expect(records).toEqual([
      { type: "ALIAS", name: "example.com", content: "hosting.example.net" },
      { type: "TLSA", name: "_443._tcp.example.com", content: "3 1 1 ABCDEF" },
      {
        type: "RRSIG",
        name: "example.com",
        content: "A 13 2 3600 20261101000000 20261001000000 2371 example.com. c2lnbmF0dXJl",
        ttl: 3600,
      },
    ]);
  });

  it('keeps a null MX (target ".") so the copy plan names it like a registrar\'s', () => {
    const records = parseBindZone(
      ["@ IN MX 0 .", "mail 300 IN MX 10 ."].join("\n"),
      "poasjet.com",
      "poasjet.zone",
    );

    expect(records).toEqual([
      { type: "MX", name: "poasjet.com", content: ".", priority: 0 },
      { type: "MX", name: "mail.poasjet.com", content: ".", priority: 10, ttl: 300 },
    ]);
    const fromFile = mapRegistrarRecord(records[0] as (typeof records)[number], "poasjet.com");
    const fromRegistrar = mapRegistrarRecord(
      { type: "MX", name: "poasjet.com", content: "0 ." },
      "poasjet.com",
    );
    expect(fromFile).toEqual(fromRegistrar);
    expect(fromFile).toEqual({
      skipped: true,
      reason:
        "The MX record for poasjet.com is a null MX: poasjet.com accepts no mail; add it in Cloudflare yourself if you want to keep it.",
    });
  });

  it("names the line of an unclosed quote without showing the line", () => {
    const error = parseError(["@ A 192.0.2.1", 'private TXT "hidden-value-1234'].join("\n"));

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("Line 2 of zone.txt");
    expect(error.message).toContain("quoted text");
    expect(`${error.message} ${error.hint}`).not.toContain("hidden-value-1234");
  });

  it("names the line of a record without a type, without echoing it", () => {
    const error = parseError(["@ A 192.0.2.1", "", "not-a-record-hidden-value-5678"].join("\n"));

    expect(error.message).toContain("Line 3 of zone.txt");
    expect(error.message).toContain("record type");
    expect(`${error.message} ${error.hint}`).not.toContain("hidden-value-5678");
  });

  it.each([
    ["@ MX mail.example.com.", "an MX record needs a preference and a mail server"],
    ["@ MX ten mail", "an MX record needs a preference and a mail server"],
    ["_sip._tcp SRV 10 60 sip", "an SRV record needs a priority, a weight, a port and a target"],
    ["@ CAA issue letsencrypt.org", "a CAA record needs flags, a tag and a value"],
    ["@ A", "the record has no data"],
    ["@ CNAME a.example.net. b.example.net.", "a CNAME record needs exactly one target"],
    ["@ CH TXT hello", "only IN-class records"],
    ["$INCLUDE other.zone", "$INCLUDE"],
    ["$TTL soon", "$TTL needs a time"],
    ["$ORIGIN", "$ORIGIN needs a name"],
    ["$GENERATE 1-10 host$ A 192.0.2.$", "only $ORIGIN and $TTL"],
    ["  A 192.0.2.1", "no name and no record before it"],
    ["@ A 192.0.2.1 )", "closing parenthesis"],
  ])("rejects %j: %s", (line, reason) => {
    const error = parseError(line);

    expect(error.message).toContain("Line 1 of zone.txt");
    expect(error.message).toContain(reason);
  });

  it("names the line where an unclosed parenthesis opened", () => {
    const error = parseError(["@ A 192.0.2.1", "@ SOA ns1 host ( 1 2 3", "4 5"].join("\n"));

    expect(error.message).toContain("Line 2 of zone.txt");
    expect(error.message).toContain("parenthesis");
  });

  it("returns no records for a file with only comments and directives", () => {
    expect(parseBindZone("; nothing\n$TTL 300\n\n", "example.com", "zone.txt")).toEqual([]);
  });
});

describe("readBindFile", () => {
  it("reads the file through the injected reader", async () => {
    const paths: string[] = [];
    const records = await readBindFile("zones/example.zone", "example.com", async (path) => {
      paths.push(path);
      return "@ A 192.0.2.1\n";
    });

    expect(paths).toEqual(["zones/example.zone"]);
    expect(records).toEqual([{ type: "A", name: "example.com", content: "192.0.2.1" }]);
  });

  it("says plainly when the file does not exist", async () => {
    const error = await readBindFile("missing.zone", "example.com", async () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
    expect((error as OpsCrewError).message).toBe(
      "OpsCrew cannot read the records file missing.zone: it does not exist.",
    );
  });

  it("reads the fixture from disk by default", async () => {
    const records = await readBindFile(FIXTURE, "example.com");

    expect(records).toHaveLength(16);
  });
});
