import { describe, expect, it } from "vitest";
import { buildXml, parseXml } from "./xml";

describe("parseXml", () => {
  it("parses a packet with repeating tags as arrays and empty elements as text", () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<packet version="1.6.9.1"><site><get><result><status>ok</status><id>007</id>
<data><hosting><vrt_hst><property><name>www_root</name><value>/var/www/vhosts/a &amp; b</value></property></vrt_hst></hosting><x/></data>
</result></get></site></packet>`;
    expect(parseXml(text)).toEqual({
      packet: {
        site: {
          get: {
            result: [
              {
                status: "ok",
                id: "007",
                data: {
                  hosting: {
                    vrt_hst: { property: [{ name: "www_root", value: "/var/www/vhosts/a & b" }] },
                  },
                  x: "",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("refuses malformed XML, an empty answer and any DOCTYPE", () => {
    expect(parseXml("<packet><site></packet>")).toBeUndefined();
    expect(parseXml("  ")).toBeUndefined();
    expect(parseXml("<html>Bad gateway")).toBeUndefined();
    expect(
      parseXml('<!DOCTYPE packet [<!ENTITY x "boom">]><packet><a>&x;</a></packet>'),
    ).toBeUndefined();
  });
});

describe("buildXml", () => {
  it("escapes text and repeats arrays in order", () => {
    const xml = buildXml({
      packet: {
        database: { "add-db-user": { login: "u<1>", password: "p&'\"", role: ["a", "b"] } },
      },
    });
    expect(xml).toContain("<login>u&lt;1&gt;</login>");
    expect(xml).toContain("<role>a</role><role>b</role>");
    expect(parseXml(xml)).toEqual({
      packet: {
        database: { "add-db-user": { login: "u<1>", password: "p&'\"", role: ["a", "b"] } },
      },
    });
  });
});
