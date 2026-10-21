import { describe, expect, it } from "vitest";
import {
  bitString,
  boolean,
  children,
  explicitTag,
  generalizedTime,
  implicitTag,
  integer,
  octetString,
  oid,
  sequence,
  set,
  utcTime,
  utf8String,
  x509Time,
} from "./der";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the DER writer", () => {
  it("writes integers in the fewest bytes, positive", () => {
    expect(hex(integer(0))).toBe("020100");
    expect(hex(integer(2))).toBe("020102");
    expect(hex(integer(127))).toBe("02017f");
    expect(hex(integer(128))).toBe("02020080");
    expect(hex(integer(256))).toBe("02020100");
    expect(hex(integer(Uint8Array.of(0, 0, 0x7f)))).toBe("02017f");
    expect(hex(integer(Uint8Array.of(0xff, 1)))).toBe("020300ff01");
    expect(() => integer(-1)).toThrow(/non-negative/);
  });

  it("writes object identifiers with multi-byte arcs", () => {
    expect(hex(oid("2.5.4.3"))).toBe("0603550403");
    expect(hex(oid("1.2.840.10045.4.3.2"))).toBe("06082a8648ce3d040302");
    expect(hex(oid("1.2.840.113549.1.9.14"))).toBe("06092a864886f70d01090e");
    expect(() => oid("1")).toThrow(/object identifier/);
  });

  it("writes strings, booleans and bit strings", () => {
    expect(hex(utf8String("é"))).toBe("0c02c3a9");
    expect(hex(octetString(Uint8Array.of(1, 2)))).toBe("04020102");
    expect(hex(boolean(true))).toBe("0101ff");
    expect(hex(boolean(false))).toBe("010100");
    expect(hex(bitString(Uint8Array.of(0x80), 7))).toBe("03020780");
    expect(hex(bitString(Uint8Array.of(0xaa)))).toBe("030200aa");
  });

  it("writes long lengths in the long form", () => {
    const long = octetString(new Uint8Array(200));
    expect(hex(long.subarray(0, 3))).toBe("0481c8");
    const longer = octetString(new Uint8Array(300));
    expect(hex(longer.subarray(0, 4))).toBe("0482012c");
    expect(longer.length).toBe(304);
  });

  it("writes sequences in order and sets sorted", () => {
    expect(hex(sequence())).toBe("3000");
    expect(hex(sequence(integer(2), integer(1)))).toBe("3006020102020101");
    expect(hex(set(integer(2), integer(1)))).toBe("3106020101020102");
  });

  it("writes UTCTime through 2049 and GeneralizedTime after", () => {
    const date = new Date("2041-10-17T10:20:30.999Z");
    expect(Buffer.from(utcTime(date).subarray(2)).toString()).toBe("411017102030Z");
    expect(hex(utcTime(date).subarray(0, 2))).toBe("170d");
    expect(Buffer.from(generalizedTime(date).subarray(2)).toString()).toBe("20411017102030Z");
    expect(hex(generalizedTime(date).subarray(0, 2))).toBe("180f");
    expect(x509Time(date)[0]).toBe(0x17);
    expect(x509Time(new Date("2050-01-01T00:00:00Z"))[0]).toBe(0x18);
    expect(() => utcTime(new Date("2050-01-01T00:00:00Z"))).toThrow(/2050/);
  });

  it("writes explicit and implicit context tags", () => {
    expect(hex(explicitTag(0, integer(2)))).toBe("a003020102");
    expect(hex(explicitTag(3, sequence()))).toBe("a3023000");
    expect(hex(implicitTag(2, new TextEncoder().encode("a.b")))).toBe("8203612e62");
    expect(hex(implicitTag(0, Uint8Array.of(0x30, 0x00), true))).toBe("a0023000");
    expect(() => explicitTag(31, sequence())).toThrow(/long form/);
  });
});

describe("the DER reader", () => {
  it("splits a sequence into its elements' complete encodings, long lengths included", () => {
    const long = octetString(new Uint8Array(300));
    const items = children(sequence(integer(2), long, sequence(boolean(true))));
    expect(items.map(hex)).toEqual(["020102", hex(long), "30030101ff"]);
    expect(children(sequence())).toEqual([]);
    expect(() => children(Uint8Array.of(0x30, 0x05, 0x02, 0x01))).toThrow(/ends early/);
    expect(() => children(Uint8Array.of(0x30))).toThrow(/ends early/);
  });
});
