import type { FetchLike, RegistrarDnsRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  type ActivationCheckResult,
  CloudflareClient,
  detectPublicIpv4,
  mapRegistrarRecord,
  mapRegistrarRecords,
  quoteTxt,
} from "./index";

const TOKEN = fakeSecret("cloudflare-token");
const API = "https://api.cloudflare.com/client/v4";
const ZONE = "example.com";

const rec = (
  type: string,
  name: string,
  content: string,
  extra: Partial<RegistrarDnsRecord> = {},
) => ({ type, name, content, ...extra }) as RegistrarDnsRecord;

const created = (r: RegistrarDnsRecord) => {
  const m = mapRegistrarRecord(r, ZONE);
  if (m.skipped) throw new Error(`skipped: ${m.reason}`);
  return m.record;
};
const skippedReason = (r: RegistrarDnsRecord) => {
  const m = mapRegistrarRecord(r, ZONE);
  if (!m.skipped) throw new Error("expected a skip");
  return m.reason;
};

describe("mapRegistrarRecord", () => {
  it("never copies a null MX or an SRV record without a service as a record for the apex", () => {
    expect(skippedReason(rec("MX", "example.com", "0 ."))).toMatch(/null MX/);
    expect(skippedReason(rec("MX", "example.com", ".", { priority: 0 }))).toMatch(/null MX/);
    expect(skippedReason(rec("SRV", "_sip._tcp.example.com", "0 0 0 ."))).toMatch(
      /service is not offered/,
    );
  });

  it("copies A and AAAA records unproxied, keeping a valid TTL", () => {
    expect(created(rec("A", "example.com", "203.0.113.10", { ttl: 300 }))).toEqual({
      type: "A",
      name: "example.com",
      content: "203.0.113.10",
      ttl: 300,
      proxied: false,
    });
    expect(created(rec("AAAA", "www.example.com", "2001:DB8::1"))).toMatchObject({
      type: "AAAA",
      content: "2001:db8::1",
      ttl: 1,
      proxied: false,
    });
    expect(skippedReason(rec("A", "example.com", "not-an-ip"))).toMatch(/IPv4/);
  });

  it("uses automatic TTL when Cloudflare would refuse the value", () => {
    expect(created(rec("A", "example.com", "203.0.113.10", { ttl: 30 })).ttl).toBe(1);
    expect(created(rec("A", "example.com", "203.0.113.10", { ttl: 999999 })).ttl).toBe(1);
  });

  it("copies CNAME and turns ALIAS into CNAME, at the apex and below", () => {
    expect(created(rec("CNAME", "www.example.com", "app.host.net."))).toMatchObject({
      type: "CNAME",
      content: "app.host.net",
    });
    expect(created(rec("ALIAS", "example.com", "lb.host.net"))).toMatchObject({
      type: "CNAME",
      name: "example.com",
      content: "lb.host.net",
      proxied: false,
    });
    expect(created(rec("ALIAS", "api.example.com", "lb.host.net"))).toMatchObject({
      type: "CNAME",
      name: "api.example.com",
    });
  });

  it("needs a priority for MX, from the field or the content", () => {
    expect(created(rec("MX", "example.com", "mx1.mail.net.", { priority: 10 }))).toMatchObject({
      type: "MX",
      content: "mx1.mail.net",
      priority: 10,
    });
    expect(created(rec("MX", "example.com", "20 mx2.mail.net"))).toMatchObject({
      content: "mx2.mail.net",
      priority: 20,
    });
    expect(created(rec("MX", "example.com", "0 mx.mail.net")).priority).toBe(0);
    expect(skippedReason(rec("MX", "example.com", "mx1.mail.net"))).toMatch(/priority/);
  });

  it("quotes TXT values and splits long ones into 255-character strings", () => {
    expect(created(rec("TXT", "example.com", "v=spf1 include:_spf.mail.net ~all")).content).toBe(
      '"v=spf1 include:_spf.mail.net ~all"',
    );
    expect(created(rec("TXT", "example.com", '"already quoted"')).content).toBe('"already quoted"');
    expect(quoteTxt('say "hi"')).toBe('"say \\"hi\\""');
    const long = "k".repeat(300);
    expect(quoteTxt(long)).toBe(`"${"k".repeat(255)}" "${"k".repeat(45)}"`);
    expect(quoteTxt("")).toBe('""');
  });

  it("builds structured data for SRV", () => {
    expect(created(rec("SRV", "_sip._tcp.example.com", "10 5 5060 sip.host.net."))).toEqual({
      type: "SRV",
      name: "_sip._tcp.example.com",
      data: { priority: 10, weight: 5, port: 5060, target: "sip.host.net" },
      ttl: 1,
      proxied: false,
    });
    expect(
      created(rec("SRV", "_sip._tcp.example.com", "5 5060 sip.host.net", { priority: 1 })).data,
    ).toEqual({ priority: 1, weight: 5, port: 5060, target: "sip.host.net" });
    expect(skippedReason(rec("SRV", "_sip._tcp.example.com", "sip.host.net"))).toMatch(
      /priority weight port target/,
    );
  });

  it("builds structured data for CAA", () => {
    expect(created(rec("CAA", "example.com", '0 issue "letsencrypt.org"')).data).toEqual({
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    });
    expect(skippedReason(rec("CAA", "example.com", "issue letsencrypt.org"))).toMatch(
      /flags tag value/,
    );
  });

  it("skips apex NS and SOA, copies a delegated NS", () => {
    expect(skippedReason(rec("NS", "example.com", "dns1.registrar.net"))).toMatch(/Cloudflare/);
    expect(skippedReason(rec("SOA", "example.com", "dns1.registrar.net. admin 1 2 3 4 5"))).toMatch(
      /managed by Cloudflare/,
    );
    expect(created(rec("NS", "lab.example.com", "ns1.other.net."))).toMatchObject({
      type: "NS",
      content: "ns1.other.net",
    });
  });

  it("skips redirect records with a pointer to redirect rules", () => {
    for (const type of ["URL", "URL301", "FRAME", "url302"]) {
      expect(skippedReason(rec(type, "example.com", "https://elsewhere.example.org"))).toMatch(
        /redirect rules/i,
      );
    }
  });

  it("skips unknown types and names outside the zone", () => {
    expect(skippedReason(rec("HINFO", "example.com", "x y"))).toMatch(/does not copy HINFO/);
    expect(skippedReason(rec("A", "example.org", "203.0.113.10"))).toMatch(/outside the zone/);
    expect(skippedReason(rec("A", "badexample.com", "203.0.113.10"))).toMatch(/outside/);
  });
});

describe("mapRegistrarRecords", () => {
  it("returns the copy plan, dropping exact duplicates", () => {
    const plan = mapRegistrarRecords(
      [
        rec("A", "example.com", "203.0.113.10"),
        rec("A", "example.com.", "203.0.113.10"),
        rec("TXT", "example.com", "hello"),
        rec("TXT", "example.com", '"hello"'),
        rec("NS", "example.com", "dns1.registrar.net"),
        rec("URL", "www.example.com", "https://example.com"),
      ],
      ZONE,
    );
    expect(plan.create.map((r) => r.type)).toEqual(["A", "TXT"]);
    expect(plan.skipped.map((s) => s.record.type)).toEqual(["NS", "URL"]);
  });

  it("keeps an apex CNAME next to MX and TXT records (only A, AAAA and CNAME conflict)", () => {
    const plan = mapRegistrarRecords(
      [
        rec("ALIAS", "example.com", "lb.host.net"),
        rec("MX", "example.com", "10 mx.mail.net"),
        rec("TXT", "example.com", "v=spf1 -all"),
      ],
      ZONE,
    );
    expect(plan.create.map((r) => r.type)).toEqual(["CNAME", "MX", "TXT"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a CNAME that shares its name with A, AAAA or another CNAME", () => {
    const plan = mapRegistrarRecords(
      [
        rec("ALIAS", "example.com", "lb.host.net"),
        rec("A", "example.com", "192.0.2.10"),
        rec("CNAME", "www.example.com", "a.host.net"),
        rec("CNAME", "www.example.com", "b.host.net"),
      ],
      ZONE,
    );
    expect(plan.create.map((r) => `${r.type} ${r.name}`)).toEqual(["A example.com"]);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped[0]?.reason).toMatch(/A, AAAA or CNAME record/);
  });
});

/** Fake fetch routed by "METHOD path"; each route may be a queue. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = String(input).replace(API, "");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const queue = routes[`${method} ${path}`];
    const route = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (!route) throw new Error(`unrouted ${method} ${path}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}
const ok = (result: unknown) => ({ body: { success: true, errors: [], messages: [], result } });
const fail = (status: number, message: string, code = 1000) => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});
const client = (routes: Record<string, { status?: number; body: unknown }[]>) => {
  const fake = fakeFetch(routes);
  const sleeps: number[] = [];
  const cf = new CloudflareClient({
    token: TOKEN,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { ...fake, cf, sleeps };
};

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  const e = error as OpsCrewError;
  expect(`${e.message} ${e.hint ?? ""}`).not.toContain(TOKEN);
  return e;
}

describe("CloudflareClient zone records", () => {
  it("returns the zone's nameservers from findZone", async () => {
    const { cf } = client({
      "GET /zones?name=example.com&per_page=1": [
        ok([{ id: "z1", name: ZONE, status: "pending", name_servers: ["a.ns.cloudflare.com"] }]),
      ],
    });
    expect(await cf.findZone(ZONE)).toEqual({
      id: "z1",
      name: ZONE,
      status: "pending",
      nameServers: ["a.ns.cloudflare.com"],
    });
  });

  it("requests an activation check and treats 'too soon' as a quiet answer", async () => {
    const { cf, calls, sleeps } = client({
      "PUT /zones/z1/activation_check": [
        ok({ id: "z1" }),
        fail(429, "Too many requests"),
        fail(400, "You may only perform this action once per hour", 1224),
      ],
      "PUT /zones/z2/activation_check": [fail(403, "Authentication error")],
    });
    expect(await cf.activationCheck("z1")).toEqual({ requested: true });
    const limited: ActivationCheckResult = await cf.activationCheck("z1");
    expect(limited).toMatchObject({ requested: false, retryAfterSeconds: 300 });
    expect(await cf.activationCheck("z1")).toMatchObject({ requested: false });
    expect(sleeps).toEqual([]);
    expect(calls[0]?.method).toBe("PUT");
    expect((await rejection(cf.activationCheck("z2"))).code).toBe("CREDENTIALS_INVALID");
  });

  it("creates records in one batch transaction and returns their ids", async () => {
    const records = mapRegistrarRecords(
      [rec("A", "example.com", "203.0.113.10"), rec("MX", "example.com", "10 mx.mail.net")],
      ZONE,
    ).create;
    const { cf, calls } = client({
      "POST /zones/z1/dns_records/batch": [ok({ posts: [{ id: "r1" }, { id: "r2" }] })],
    });
    expect(await cf.batchCreateRecords("z1", records)).toEqual(["r1", "r2"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ posts: records });
  });

  it("splits batches over 200 records", async () => {
    const records = Array.from({ length: 250 }, (_, i) => created(rec("TXT", ZONE, `v${i}`)));
    const { cf, calls } = client({
      "POST /zones/z1/dns_records/batch": [
        ok({ posts: [{ id: "a" }] }),
        ok({ posts: [{ id: "b" }] }),
      ],
    });
    expect(await cf.batchCreateRecords("z1", records)).toEqual(["a", "b"]);
    const sizes = calls.map((c) => (c.body as { posts: unknown[] }).posts.length);
    expect(sizes).toEqual([200, 50]);
  });

  it("explains a failed batch in plain English and does not retry it", async () => {
    const { cf, calls } = client({
      "POST /zones/z1/dns_records/batch": [
        fail(400, "An A, AAAA, or CNAME record with that host already exists.", 81053),
      ],
    });
    const error = await rejection(
      cf.batchCreateRecords("z1", [created(rec("A", ZONE, "203.0.113.10"))]),
    );
    expect(error.message).toMatch(/Cloudflare could not create 1 DNS record: An A/);
    expect(error.hint).toMatch(/None of the records/);
    expect(calls).toHaveLength(1);
  });

  it("scans DNS records, polls an empty review, and never accepts it", async () => {
    const { cf, calls, sleeps } = client({
      "POST /zones/z1/dns_records/scan/trigger": [ok({ id: "z1" })],
      "GET /zones/z1/dns_records/scan/review": [
        ok([]),
        ok([
          { id: "s1", type: "A", name: "example.com", content: "203.0.113.10", ttl: 300 },
          {
            id: "s2",
            type: "MX",
            name: "example.com",
            content: "mx.mail.net",
            priority: 10,
            ttl: 1,
          },
          {
            id: "s3",
            type: "SRV",
            name: "_sip._tcp.example.com",
            content: "5 5060 sip.host.net",
            data: { priority: 10, weight: 5, port: 5060, target: "sip.host.net" },
            ttl: 1,
          },
          {
            id: "s4",
            type: "CAA",
            name: "example.com",
            data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
            ttl: 1,
          },
        ]),
      ],
    });
    const found = await cf.scanDnsRecords("z1");
    expect(found).toEqual([
      { type: "A", name: "example.com", content: "203.0.113.10", ttl: 300 },
      { type: "MX", name: "example.com", content: "mx.mail.net", ttl: 1, priority: 10 },
      {
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: "10 5 5060 sip.host.net",
        ttl: 1,
        priority: 10,
      },
      { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"', ttl: 1 },
    ]);
    expect(sleeps).toEqual([2000]);
    expect(calls.every((c) => c.method !== "POST" || c.path.endsWith("/trigger"))).toBe(true);
    const plan = mapRegistrarRecords(found, ZONE);
    expect(plan.create).toHaveLength(4);
  });

  it("gives up on an empty scan review after a few reads", async () => {
    const { cf, sleeps } = client({
      "POST /zones/z1/dns_records/scan/trigger": [ok(null)],
      "GET /zones/z1/dns_records/scan/review": [ok(null)],
    });
    expect(await cf.scanDnsRecords("z1")).toEqual([]);
    expect(sleeps).toHaveLength(4);
  });

  it("returns the DS fields when DNSSEC is active or pending", async () => {
    const dnssec = {
      ds: "example.com. 3600 IN DS 2371 13 2 ABCDEF",
      key_tag: 2371,
      algorithm: "13",
      digest_type: "2",
      digest: "ABCDEF",
    };
    const { cf } = client({
      "GET /zones/z1/dnssec": [
        ok({ status: "pending", ...dnssec }),
        ok({ status: "disabled", key_tag: null, algorithm: null, digest_type: null }),
      ],
    });
    expect(await cf.getDnssec("z1")).toEqual({
      status: "pending",
      ds: dnssec.ds,
      keyTag: 2371,
      algorithm: 13,
      digestType: 2,
      digest: "ABCDEF",
    });
    expect(await cf.getDnssec("z1")).toEqual({ status: "disabled" });
  });
});

describe("detectPublicIpv4", () => {
  const trace =
    (body: string, status = 200): FetchLike =>
    async (input) => {
      expect(String(input)).toBe("https://www.cloudflare.com/cdn-cgi/trace");
      return new Response(body, { status });
    };

  it("reads the ip= line", async () => {
    expect(
      await detectPublicIpv4(trace("fl=1\nh=www.cloudflare.com\nip=198.51.100.7\nts=1\n")),
    ).toBe("198.51.100.7");
  });

  it("refuses IPv6, garbage, errors and network failures with a plain message", async () => {
    const offline: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    for (const fetch of [
      trace("ip=2001:db8::1\n"),
      trace("nothing here"),
      trace("ip=198.51.100.7\n", 500),
      offline,
    ]) {
      const error = await rejection(detectPublicIpv4(fetch));
      expect(error.message).toMatch(/public IPv4 address of this computer could not be detected/);
      expect(error.hint).toContain("Set NAMECHEAP_CLIENT_IP to");
      expect(error.hint).not.toMatch(/NAMECHEAP_CLIENT_IP:/);
    }
  });
});
