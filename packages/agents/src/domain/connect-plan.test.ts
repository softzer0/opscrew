import type { RegistrarDnsRecord } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalIpv6,
  copyPlan,
  createLines,
  managedText,
  missingFromZone,
  unquoteTxt,
} from "./connect-plan";

const DOMAIN = "example.com";

const RECORDS: RegistrarDnsRecord[] = [
  { type: "A", name: "example.com", content: "192.0.2.10", ttl: 600 },
  { type: "MX", name: "example.com", content: "mx1.example.net", priority: 10 },
  { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.example.net ~all" },
  { type: "SRV", name: "_sip._tcp.example.com", content: "60 5060 sip.example.com", priority: 10 },
  { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"' },
];

describe("copyPlan", () => {
  it("maps the records to Cloudflare records", () => {
    const plan = copyPlan(RECORDS, DOMAIN, []);

    expect(plan.present).toBe(0);
    expect(createLines(plan, RECORDS, DOMAIN)).toEqual([
      "A example.com 192.0.2.10",
      "MX example.com 10 mx1.example.net",
      'TXT example.com "v=spf1 include:_spf.example.net ~all"',
      "SRV _sip._tcp.example.com 10 60 5060 sip.example.com",
      'CAA example.com 0 issue "letsencrypt.org"',
    ]);
  });

  it("leaves out records the zone already has, in Cloudflare's content format", () => {
    const plan = copyPlan(RECORDS, DOMAIN, [
      { type: "A", name: "example.com", content: "192.0.2.10" },
      { type: "MX", name: "Example.com", content: "MX1.example.net." },
      { type: "TXT", name: "example.com", content: '"v=spf1 include:_spf.example.net ~all"' },
      { type: "SRV", name: "_sip._tcp.example.com", content: "60 5060 sip.example.com" },
      { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"' },
      { type: "A", name: "other.example.com", content: "192.0.2.99" },
    ]);

    expect(plan.create).toEqual([]);
    expect(plan.present).toBe(5);
  });

  it("copies only what is missing (a different value is not the same record)", () => {
    const plan = copyPlan(RECORDS.slice(0, 3), DOMAIN, [
      { type: "A", name: "example.com", content: "192.0.2.11" },
      { type: "TXT", name: "example.com", content: '"v=spf1 include:_spf.example.net ~all"' },
    ]);

    expect(plan.create.map((r) => r.type)).toEqual(["A", "MX"]);
    expect(plan.present).toBe(1);
  });

  it("says how ALIAS maps and why records are not copied", () => {
    const records: RegistrarDnsRecord[] = [
      { type: "ALIAS", name: "example.com", content: "pixie.porkbun.com" },
      { type: "ALIAS", name: "shop.example.com", content: "shops.example.net" },
      { type: "URL", name: "go.example.com", content: "https://example.net/landing" },
      {
        type: "EMAIL-FORWARDING",
        name: "example.com",
        content:
          "Namecheap email forwarding (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing)",
      },
      { type: "RRSIG", name: "example.com", content: "A 13 2 3600 20261101000000" },
      { type: "SOA", name: "example.com", content: "ns1.example.net hostmaster.example.com 1" },
      { type: "NS", name: "example.com", content: "ns1.example.net" },
      { type: "NS", name: "example.com", content: "ns2.example.net" },
      { type: "NS", name: "lab.example.com", content: "ns.lab.example.net" },
    ];

    const plan = copyPlan(records, DOMAIN, []);

    expect(createLines(plan, records, DOMAIN)).toEqual([
      "CNAME example.com pixie.porkbun.com (the ALIAS record, as a CNAME: Cloudflare flattens a CNAME at the apex, so it answers like ALIAS)",
      "CNAME shop.example.com shops.example.net (the ALIAS record, as a CNAME)",
      "NS lab.example.com ns.lab.example.net",
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "The URL record for go.example.com is a registrar redirect or forwarding record, which is not a DNS record; recreate it with Cloudflare redirect rules (Rules → Redirect Rules in the dashboard).",
      "Mail for example.com: Namecheap email forwarding (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing).",
      "The RRSIG record for example.com is DNSSEC data of the current DNS provider; Cloudflare signs the zone itself once DNSSEC is on.",
    ]);
    expect(managedText(plan, DOMAIN)).toBe("the SOA record and 2 NS records of example.com");
  });
});

describe("copyPlan against the zone", () => {
  it("compares IPv6 addresses in their canonical form, both ways", () => {
    const short = { type: "AAAA", name: DOMAIN, content: "2001:db8::1" };
    const long = { type: "AAAA", name: DOMAIN, content: "2001:0db8:0:0::1" };

    const plan = copyPlan([short], DOMAIN, [long]);
    expect(plan).toMatchObject({ create: [], present: 1, extra: [], clashes: [] });
    expect(copyPlan([long], DOMAIN, [short])).toMatchObject({ create: [], present: 1 });
    expect(canonicalIpv6("2001:0DB8:0:0::1")).toBe("2001:db8::1");
  });

  it("keeps the MX and SRV priority in the comparison when both sides have it", () => {
    const records: RegistrarDnsRecord[] = [
      { type: "MX", name: DOMAIN, content: "mx1.example.net", priority: 10 },
      {
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: "60 5060 sip.example.com",
        priority: 10,
      },
    ];

    // Other priorities: not the same records (both copied; the zone's stay and are listed).
    const other = copyPlan(records, DOMAIN, [
      { type: "MX", name: DOMAIN, content: "20 mx1.example.net" },
      { type: "SRV", name: "_sip._tcp.example.com", content: "5 60 5060 sip.example.com" },
    ]);
    expect(other.create.map((r) => r.type)).toEqual(["MX", "SRV"]);
    expect(other.extra.map((r) => r.type)).toEqual(["MX", "SRV"]);
    expect(other.clashes).toEqual([]);

    // The same priorities, or a zone record without one: the same records.
    const same = copyPlan(records, DOMAIN, [
      { type: "MX", name: DOMAIN, content: "10 mx1.example.net" },
      { type: "SRV", name: "_sip._tcp.example.com", content: "60 5060 sip.example.com" },
    ]);
    expect(same).toMatchObject({ create: [], present: 2, extra: [] });
  });

  it("uses the zone's MX priority: MX 10 is not MX 20 for the same server (listed, no clash)", () => {
    const zoneMx = { type: "MX", name: DOMAIN, content: "mx1.example.net", priority: 10 };

    const plan = copyPlan(
      [{ type: "MX", name: DOMAIN, content: "mx1.example.net", priority: 20 }],
      DOMAIN,
      [zoneMx],
    );

    expect(plan.create.map((r) => r.priority)).toEqual([20]);
    expect(plan).toMatchObject({ present: 0, extra: [zoneMx], clashes: [] });
    expect(
      copyPlan([{ type: "MX", name: DOMAIN, content: "mx1.example.net", priority: 10 }], DOMAIN, [
        zoneMx,
      ]),
    ).toMatchObject({ create: [], present: 1 });
  });

  it("stops for other mail servers in the zone, said once per name", () => {
    const plan = copyPlan(
      [{ type: "MX", name: DOMAIN, content: "mx1.example.net", priority: 10 }],
      DOMAIN,
      [
        { type: "MX", name: DOMAIN, content: "mx.other.example", priority: 10 },
        { type: "MX", name: DOMAIN, content: "mx2.other.example", priority: 20 },
      ],
    );

    expect(plan.clashes).toEqual([
      "the Cloudflare zone already has other mail servers for example.com: mx.other.example, mx2.other.example, next to the current ones (mx1.example.net); after the switch mail would be split between them",
    ]);
    expect(plan.extra).toEqual([]);
  });

  it("serves the zone's mail servers when the current DNS has none for that name", () => {
    const zoneMx = {
      type: "MX",
      name: `shop.${DOMAIN}`,
      content: "mx.other.example",
      priority: 10,
    };

    const plan = copyPlan(RECORDS, DOMAIN, [zoneMx]);

    expect(plan).toMatchObject({ clashes: [], extra: [zoneMx] });
  });

  it("stops for a second SPF policy; the same policy written differently is not a second one", () => {
    const spf = { type: "TXT", name: DOMAIN, content: "v=spf1 include:_spf.example.net ~all" };

    const second = copyPlan([spf], DOMAIN, [
      { type: "TXT", name: DOMAIN, content: '"v=spf1 include:_spf.other.example -all"' },
    ]);
    expect(second.clashes).toEqual([
      'the Cloudflare zone already has another SPF record for example.com ("v=spf1 include:_spf.other.example -all") next to the current one ("v=spf1 include:_spf.example.net ~all"); with more than one SPF record on a name, mail checks fail',
    ]);

    // The zone's spelling of the same policy is the same record: it is not copied a second time.
    const same = copyPlan([spf], DOMAIN, [
      { type: "TXT", name: DOMAIN, content: '"V=SPF1  include:_spf.example.net   ~all"' },
      { type: "TXT", name: DOMAIN, content: '"google-site-verification=token"' },
    ]);
    expect(same).toMatchObject({ create: [], present: 1, clashes: [] });
    expect(same.extra.map((r) => r.content)).toEqual(['"google-site-verification=token"']);
  });

  it("finds the records the zone lacks", () => {
    const plan = copyPlan(RECORDS, DOMAIN, []);

    expect(
      missingFromZone(plan.create, [
        { type: "A", name: DOMAIN, content: "192.0.2.10" },
        { type: "MX", name: DOMAIN, content: "mx1.example.net" },
      ]).map((r) => r.type),
    ).toEqual(["TXT", "SRV", "CAA"]);
  });
});

describe("unquoteTxt", () => {
  it.each([
    ['"plain"', "plain"],
    ['"a" "b"', "ab"],
    ['"say \\"hi\\""', 'say "hi"'],
    ['"semi\\059colon"', "semi;colon"],
    ["not quoted", "not quoted"],
  ])("%s → %s", (input, output) => {
    expect(unquoteTxt(input)).toBe(output);
  });
});
