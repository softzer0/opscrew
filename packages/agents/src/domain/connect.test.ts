import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistrarDnsRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type ConnectProject, connectProject, OLD_DS } from "./__fixtures__/connect";
import {
  domainTestPlan,
  RUN_NOW,
  testRequirements,
  visibleText,
  ZONE_DS,
  ZONE_NAMESERVERS,
} from "./__fixtures__/fakes";
import { DEFAULT_NAMESERVERS, SEEDED_CONTACT } from "./__fixtures__/registrars";
import { connectDomain } from "./connect";
import { registrarLinks } from "./registrars";
import { SANDBOX_NAMESERVERS, SANDBOX_ZONES } from "./services";
import { dsRecordText } from "./switch";
import type { DomainZoneApi } from "./types";

const DOMAIN = "shopapp.com";
const ZONE = `zone-${DOMAIN}`;
const FIXTURE = fileURLToPath(new URL("./__fixtures__/connect-example.zone", import.meta.url));
const NAMECHEAP_LINK = registrarLinks("namecheap").domains;
const GODADDY_LINK = registrarLinks("godaddy").domains;
/** Nameservers of a DNS host that is not the registrar. */
const OTHER_DNS = ["ns1.dnshost.example", "ns2.dnshost.example"];

const MX: RegistrarDnsRecord = {
  type: "MX",
  name: DOMAIN,
  content: "mx1.mail.example.net",
  priority: 10,
  ttl: 600,
};
const TXT: RegistrarDnsRecord = {
  type: "TXT",
  name: DOMAIN,
  content: "v=spf1 include:_spf.mail.example.net ~all",
  ttl: 600,
};
const { ds: _line, ...ZONE_DS_RECORD } = ZONE_DS;

function stateFile(deps: { paths: { projectHomeDir: string } }): string {
  return join(deps.paths.projectHomeDir, "domain-connect.json");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function readState(deps: { paths: { projectHomeDir: string } }) {
  return JSON.parse(await readFile(stateFile(deps), "utf8")) as Record<string, unknown>;
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Events since the last call (the list is shared by every run of the project). */
function eventsOf(cp: ConnectProject) {
  let seen = 0;
  return () => {
    const events = cp.project.cf.events.slice(seen);
    seen = cp.project.cf.events.length;
    return events;
  };
}

/** A project (plan and requirements without a domain) and shopapp.com on Porkbun's DNS. */
async function porkbunHosted(options: Parameters<typeof connectProject>[0] = {}) {
  const cp = await connectProject({
    plan: domainTestPlan(),
    requirements: testRequirements(),
    ...options,
  });
  const pb = cp.other("porkbun");
  pb.own(DOMAIN);
  pb.records.set(DOMAIN, [{ ...MX }, { ...TXT }]);
  return { cp, pb };
}

/** The Cloudflare zone of shopapp.com exists in the account already. */
function zoneExists(cp: ConnectProject, status = "pending", accountId?: string): void {
  cp.project.cf.zones.set(DOMAIN, {
    id: ZONE,
    name: DOMAIN,
    status,
    nameServers: [...ZONE_NAMESERVERS],
    ...(accountId === undefined ? {} : { accountId }),
  });
}

describe("connectDomain: copy, then switch (US2)", () => {
  it("copies the MX and TXT records into a new zone before it switches the nameservers (SC-703)", async () => {
    const { cp, pb } = await porkbunHosted();
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(cp.project.cf.events).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      `porkbun listRecords ${DOMAIN}`,
      "approval domain-settings",
      `createZone acc-1 ${DOMAIN}`,
      `createRecords ${ZONE} MX,TXT`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${ZONE_NAMESERVERS.join(",")}`,
      `activationCheck ${ZONE}`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(cp.zones.created).toEqual([
      {
        zoneId: ZONE,
        records: [
          {
            type: "MX",
            name: DOMAIN,
            content: "mx1.mail.example.net",
            priority: 10,
            ttl: 600,
            proxied: false,
          },
          {
            type: "TXT",
            name: DOMAIN,
            content: '"v=spf1 include:_spf.mail.example.net ~all"',
            ttl: 600,
            proxied: false,
          },
        ],
      },
    ]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);

    // one typed approval that lists the zone, the records and the switch
    expect(handler.requests).toHaveLength(1);
    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "domain-settings",
      title: "Move the DNS of shopapp.com to Cloudflare",
      confirmPhrase: DOMAIN,
    });
    for (const line of [
      "Domain: shopapp.com (registered at Porkbun)",
      "Cloudflare account: Shop (acc-1)",
      "Cloudflare zone: OpsCrew creates one for shopapp.com in this account.",
      "Current records: 2 records read from Porkbun's DNS.",
      'Records OpsCrew creates in the zone (2):\n  MX shopapp.com 10 mx1.mail.example.net\n  TXT shopapp.com "v=spf1 include:_spf.mail.example.net ~all"',
      `Nameservers at Porkbun: ${DEFAULT_NAMESERVERS.porkbun.join(" and ")} → the zone's Cloudflare nameservers`,
      "asks Cloudflare to check the nameservers",
      "within 48 hours",
      "DNSSEC: turned on in a later run, once Cloudflare has activated the zone",
      "opscrew/plan.yaml: the app is served at shopapp.com through Cloudflare",
      "opscrew/requirements.yaml: domain shopapp.com, dnsProvider cloudflare.",
    ]) {
      expect(approval?.details).toContain(line);
    }

    expect(result).toMatchObject({
      outcome: "connected",
      domain: DOMAIN,
      registrar: "porkbun",
      zoneId: ZONE,
      nameservers: ZONE_NAMESERVERS,
      copied: 2,
      dnssec: false,
      recorded: { plan: true, requirements: true },
    });
    const next = result.next.join("\n");
    expect(next).toContain("usually within an hour and sometimes up to 48 hours");
    expect(next).toContain("re-checks the nameservers on its own");
    expect(next).toContain("adds the zone's DS record at Porkbun");
    expect(next).toContain("opscrew provision");

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: DOMAIN,
      zone: DOMAIN,
      registration: {
        registrar: "porkbun",
        autoRenew: true,
        privacy: true,
        dnssec: false,
        expiresAt: "2027-01-02T03:04:05.000Z",
      },
    });
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    expect(requirements).toMatchObject({ domain: DOMAIN, dnsProvider: "cloudflare" });

    expect(deps.audit.entries.map((e) => e.action)).toEqual([
      "domain-settings",
      "ensure zone",
      "copy DNS records",
      "set nameservers",
      "zone activation check",
      "connect domain",
    ]);
    expect(deps.audit.entries.find((e) => e.action === "copy DNS records")?.detail).toBe(
      `2 records (MX, TXT) from Porkbun's DNS into zone ${ZONE}`,
    );
    for (const value of Object.values(SEEDED_CONTACT)) {
      expect(visibleText(deps)).not.toContain(value);
    }
    expect(visibleText(deps)).not.toMatch(/[A-Z][A-Z0-9_]+_[A-Z0-9_]+:/);
    expect(await exists(stateFile(deps))).toBe(false);
  });

  it.each([
    ["refused", { answer: () => false }, "when you want to move it"],
    [
      "mistyped",
      { answer: () => ({ approved: true, confirmation: "shopapp.co" }) },
      "type shopapp.com exactly",
    ],
    ["granted by --yes only", { assumeYes: true }, "type shopapp.com exactly"],
  ])("changes nothing when the approval is %s", async (_case, runOptions, hint) => {
    const { cp, pb } = await porkbunHosted();
    const { deps, services } = await cp.run(runOptions);

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe("shopapp.com was not moved to Cloudflare; OpsCrew changed nothing.");
    expect(error.hint).toContain(hint);
    const events = cp.project.cf.events;
    expect(events.at(-1)).toBe("approval domain-settings");
    expect(cp.project.cf.zones.size).toBe(0);
    expect(cp.zones.created).toEqual([]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
    expect((await readArtifact("plan", deps.paths.files.plan)).dns.provider).toBe("none");
    expect(deps.audit.entries.map((e) => [e.action, e.decision])).toEqual([
      ["domain-settings", "refused"],
    ]);
  });

  it("names --confirm when a run without a terminal is not approved", async () => {
    const { cp } = await porkbunHosted();
    const { deps, services } = await cp.run({ interactive: false, answer: () => false });

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.hint).toBe(
      "To move it without a terminal, run `opscrew domain connect shopapp.com --confirm shopapp.com`; or run it in an interactive terminal.",
    );
  });

  it("keeps the given registrar, records file and account in the commands it names", async () => {
    const cp = await connectProject();
    const pb = cp.other("porkbun");
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...OTHER_DNS]);
    const { deps, services } = await cp.run({ interactive: false, answer: () => false });
    const file = join(deps.paths.root, "my zones", "it's.zone");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `$ORIGIN ${DOMAIN}.\n@ 3600 IN A 203.0.113.5\n`);

    const error = await caught(
      connectDomain(deps, {
        domain: DOMAIN,
        registrar: "porkbun",
        recordsFile: "my zones/it's.zone",
        account: "acc-1",
        services,
      }),
    );

    expect(error.hint).toBe(
      "To move it without a terminal, run `opscrew domain connect shopapp.com --registrar porkbun --records-file 'my zones/it'\\''s.zone' --account acc-1 --confirm shopapp.com`; or run it in an interactive terminal.",
    );
  });

  it("says how to continue when a change fails after the approval, and the next run finishes", async () => {
    const { cp, pb } = await porkbunHosted();
    pb.failures.setNameservers = (call) =>
      call === 1
        ? new OpsCrewError("PROVIDER_ERROR", "Porkbun did not answer.", {
            hint: "Try again in a minute.",
          })
        : undefined;
    const first = await cp.run();

    const error = await caught(
      connectDomain(first.deps, { domain: DOMAIN, services: first.services }),
    );

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "OpsCrew could not finish moving shopapp.com to Cloudflare: Porkbun did not answer.",
    );
    expect(error.hint).toBe(
      "Try again in a minute. Then run `opscrew domain connect shopapp.com` again: it checks what is done and continues from there.",
    );
    expect(cp.zones.created).toHaveLength(1);

    const second = await cp.run();
    const result = await connectDomain(second.deps, { domain: DOMAIN, services: second.services });

    expect(result).toMatchObject({ outcome: "connected", copied: 0 });
    expect(second.handler.requests[0]?.details).toContain(
      "Already in the zone, not created again: 2 records.",
    );
    expect(cp.zones.created).toHaveLength(1);
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("uses stand-in zones in a registrar sandbox and then counts the domain as connected", async () => {
    const { cp, pb } = await porkbunHosted();
    const first = await cp.run();
    first.services.zones = SANDBOX_ZONES;

    const result = await connectDomain(first.deps, { domain: DOMAIN, services: first.services });

    expect(result).toMatchObject({ outcome: "connected", copied: 2, zoneId: "sandbox" });
    expect(pb.nameservers.get(DOMAIN)).toEqual(SANDBOX_NAMESERVERS);
    expect(first.handler.requests[0]?.details).toContain("Cloudflare zone: a stand-in");
    expect(first.deps.audit.entries.map((e) => e.action)).not.toContain("ensure zone");
    expect(result.next.join("\n")).not.toContain("Cloudflare activates the zone");

    const second = await cp.run();
    second.services.zones = SANDBOX_ZONES;
    const again = await connectDomain(second.deps, { domain: DOMAIN, services: second.services });
    expect(again.outcome).toBe("already-connected");
    expect(second.handler.requests).toEqual([]);
  });

  it("stops before any call without a Cloudflare token", async () => {
    const { cp } = await porkbunHosted();
    const { deps, services } = await cp.run({ token: null });

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("set CLOUDFLARE_API_TOKEN to a token that can create zones");
    expect(cp.project.cf.events).toEqual([]);
  });

  it("rejects a name that is not a domain", async () => {
    const { cp } = await porkbunHosted();
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: "https://shopapp.com/", services }));

    expect(error.code).toBe("INVALID_INPUT");
    expect(cp.project.cf.events).toEqual([]);
  });
});

describe("connectDomain: finding the registrar", () => {
  it("uses the one configured account that owns the domain", async () => {
    const { cp } = await porkbunHosted();
    cp.other("namecheap");
    const { deps, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result.registrar).toBe("porkbun");
    expect(cp.project.cf.events.slice(0, 2)).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      `namecheap ownsDomain ${DOMAIN}`,
    ]);
  });

  it("asks for --registrar when several accounts own it", async () => {
    const { cp } = await porkbunHosted();
    cp.other("namecheap").own(DOMAIN);
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(
      "more than one of your registrar accounts (Porkbun and Namecheap)",
    );
    expect(error.hint).toContain("--registrar porkbun");
    expect(cp.project.cf.events).not.toContain("accounts");
  });

  it("says plainly when no configured account owns it, naming what was checked", async () => {
    const cp = await connectProject();
    cp.other("porkbun");
    cp.other("namecheap");
    cp.ownsErrors.set(
      "namecheap",
      new OpsCrewError("CREDENTIALS_INVALID", "Namecheap refused the API call from 198.51.100.4"),
    );
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "shopapp.com is not in any configured registrar account: OpsCrew looked in your Porkbun and Namecheap accounts. Namecheap could not be checked (Namecheap refused the API call from 198.51.100.4). Nothing was changed.",
    );
    expect(error.hint).toContain("--registrar (porkbun, namecheap or godaddy)");
    expect(error.hint).toContain("PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY for Porkbun");
    expect(error.hint).toContain("GODADDY_API_TOKEN for GoDaddy");
    expect(`${error.message} ${error.hint}`).not.toMatch(/[A-Z]+_[A-Z_]+:/);
  });

  it("uses --registrar without asking the other accounts", async () => {
    const { cp } = await porkbunHosted();
    const nc = cp.other("namecheap");
    nc.own(DOMAIN);
    nc.records.set(DOMAIN, [{ ...MX }]);
    const { deps, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, registrar: "namecheap", services });

    expect(result).toMatchObject({ outcome: "connected", registrar: "namecheap", copied: 1 });
    expect(cp.project.cf.events.filter((e) => e.includes("ownsDomain"))).toEqual([]);
    // Namecheap's API cannot read DS records: the public lookup decides
    expect(cp.project.cf.events).toContain(`dns DS ${DOMAIN}`);
    expect(nc.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("stops for --registrar cloudflare: those domains are on Cloudflare DNS already", async () => {
    const { cp } = await porkbunHosted();
    const { deps, services } = await cp.run();

    const error = await caught(
      connectDomain(deps, { domain: DOMAIN, registrar: "cloudflare", services }),
    );

    expect(error.message).toBe(
      "Domains registered at Cloudflare always use Cloudflare DNS, so there is nothing to connect for shopapp.com.",
    );
    expect(error.hint).toContain("opscrew domain buy shopapp.com");
    expect(cp.project.cf.events).toEqual([]);
  });

  it("says what to set when no registrar other than Cloudflare is set up", async () => {
    const cp = await connectProject();
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.hint).toContain("NAMECHEAP_API_USER and NAMECHEAP_API_KEY for Namecheap");
  });

  it("stops with the dashboard link when the registrar's API cannot change nameservers", async () => {
    const cp = await connectProject();
    cp.other("godaddy", { nameservers: false }).own(DOMAIN);
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.message).toBe(
      "GoDaddy's API cannot change nameservers, so OpsCrew cannot move shopapp.com to Cloudflare there. Nothing was changed.",
    );
    expect(error.hint).toContain(GODADDY_LINK);
    expect(cp.project.cf.events).toEqual([`godaddy ownsDomain ${DOMAIN}`, "accounts"]);
  });
});

describe("connectDomain: records the registrar does not host", () => {
  it("copies the records of a BIND file (a path relative to the project)", async () => {
    const cp = await connectProject({ plan: domainTestPlan(), requirements: testRequirements() });
    const pb = cp.other("porkbun");
    pb.own("example.com");
    pb.nameservers.set("example.com", [...OTHER_DNS]);
    const { deps, handler, services } = await cp.run();
    const file = join(deps.paths.root, "zones", "example.zone");
    await mkdir(dirname(file), { recursive: true });
    await copyFile(FIXTURE, file);

    const result = await connectDomain(deps, {
      domain: "example.com",
      recordsFile: "zones/example.zone",
      services,
    });

    expect(result).toMatchObject({ outcome: "connected", copied: 13, zoneId: "zone-example.com" });
    expect(cp.project.cf.events).not.toContain("porkbun listRecords example.com");
    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain("Current records: 16 records read from the file zones/example.zone.");
    expect(details).toContain("Records OpsCrew creates in the zone (13):");
    expect(details).toContain("  SRV _sip._tcp.example.com 10 60 5060 sip.example.com");
    expect(details).toContain('  CAA example.com 0 issue "letsencrypt.org"');
    expect(details).toContain(
      "Not copied because Cloudflare manages its own: the SOA record and 2 NS records of example.com.",
    );
    expect(details).toContain(
      "Nameservers at Porkbun: ns1.dnshost.example and ns2.dnshost.example → the zone's Cloudflare nameservers",
    );
    expect(cp.zones.created[0]?.records.map((r) => r.type)).toEqual([
      "A",
      "AAAA",
      "CNAME",
      "A",
      "CNAME",
      "MX",
      "MX",
      "A",
      "TXT",
      "TXT",
      "TXT",
      "SRV",
      "CAA",
    ]);
    expect(deps.audit.entries.find((e) => e.action === "copy DNS records")?.detail).toContain(
      "from a BIND file",
    );
  });

  it("stops at an unreadable line of the BIND file before any change", async () => {
    const cp = await connectProject();
    cp.other("porkbun").own(DOMAIN);
    const { deps, services } = await cp.run();
    const file = join(deps.paths.root, "broken.zone");
    await writeFile(file, '@ A 192.0.2.1\n@ TXT "unclosed-hidden-value\n');

    const error = await caught(
      connectDomain(deps, { domain: DOMAIN, recordsFile: file, services }),
    );

    expect(error.message).toContain(`Line 2 of ${file}`);
    expect(`${error.message} ${error.hint}`).not.toContain("unclosed-hidden-value");
    expect(cp.project.cf.zones.size).toBe(0);
  });

  it("scans with Cloudflare after its own approval: the zone is created only after it", async () => {
    const cp = await connectProject({ plan: domainTestPlan(), requirements: testRequirements() });
    const pb = cp.other("porkbun");
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...OTHER_DNS]);
    cp.zones.scans.set(DOMAIN, [
      { type: "A", name: DOMAIN, content: "192.0.2.10", ttl: 300 },
      { ...MX },
      { type: "NS", name: DOMAIN, content: OTHER_DNS[0] as string },
    ]);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(cp.project.cf.events).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      `porkbun listRecords ${DOMAIN}`,
      "approval domain-settings",
      `createZone acc-1 ${DOMAIN}`,
      `scanRecords ${ZONE}`,
      `listRecords ${ZONE}`,
      "approval domain-settings",
      `createRecords ${ZONE} A,MX`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${ZONE_NAMESERVERS.join(",")}`,
      `activationCheck ${ZONE}`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(handler.requests.map((r) => [r.title, r.confirmPhrase])).toEqual([
      ["Create a Cloudflare zone for shopapp.com to scan its current records", DOMAIN],
      ["Move the DNS of shopapp.com to Cloudflare", DOMAIN],
    ]);
    expect(handler.requests[0]?.details).toContain("Nothing live changes");
    const details = handler.requests[1]?.details ?? "";
    expect(details).toContain(`Cloudflare zone: ${ZONE}, created for the scan`);
    expect(details).toContain("read from Cloudflare's scan of the public DNS");
    expect(details).toContain(
      `Nameservers at Porkbun: ns1.dnshost.example and ns2.dnshost.example → ${ZONE_NAMESERVERS.join(" and ")}.`,
    );
    expect(result).toMatchObject({ outcome: "connected", copied: 2 });
  });

  it("creates nothing when the scan is refused", async () => {
    const cp = await connectProject();
    const pb = cp.other("porkbun");
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...OTHER_DNS]);
    const { deps, services } = await cp.run({ answer: () => false });

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      "OpsCrew did not create a zone for shopapp.com; nothing was changed.",
    );
    expect(error.hint).toContain("--records-file");
    expect(cp.project.cf.zones.size).toBe(0);
  });

  it("says only the pending zone exists when the copy is refused after the scan", async () => {
    const cp = await connectProject();
    const pb = cp.other("porkbun");
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...OTHER_DNS]);
    const { deps, services } = await cp.run({
      answer: (request) => request.title.startsWith("Create a Cloudflare zone"),
    });

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.message).toBe(
      "shopapp.com was not moved to Cloudflare. OpsCrew only created the pending zone for the scan, which nothing live uses.",
    );
    expect(pb.nameservers.get(DOMAIN)).toEqual(OTHER_DNS);
    expect(cp.zones.created).toEqual([]);
  });

  it("stops without a terminal unless a records file is given", async () => {
    const cp = await connectProject();
    const pb = cp.other("porkbun");
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...OTHER_DNS]);
    const { deps, handler, services } = await cp.run({ interactive: false });

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "Porkbun does not serve the DNS records of shopapp.com (its nameservers are ns1.dnshost.example and ns2.dnshost.example)",
    );
    expect(error.hint).toContain(`opscrew domain connect ${DOMAIN} --records-file <file>`);
    expect(handler.requests).toEqual([]);
    expect(cp.project.cf.zones.size).toBe(0);
  });
});

describe("connectDomain: old DNSSEC records", () => {
  it("removes them through Porkbun's API after the approval, then waits until the public DNS has forgotten them", async () => {
    const { cp, pb } = await porkbunHosted();
    pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    // The public resolver's copy has an hour left.
    cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }], ttl: 3600 });
    const events = eventsOf(cp);

    // Run 1: zone, records, DS removal; then it stops before the switch.
    const first = await cp.run();
    const removed = await connectDomain(first.deps, { domain: DOMAIN, services: first.services });

    expect(events()).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      `porkbun listRecords ${DOMAIN}`,
      "approval domain-settings",
      `createZone acc-1 ${DOMAIN}`,
      `createRecords ${ZONE} MX,TXT`,
      `porkbun removeDsRecord ${DOMAIN} 4012`,
    ]);
    // 24 hours after the public copy expires (13:00), plus an hour after a removal.
    expect(removed).toMatchObject({
      outcome: "waiting-for-ds",
      zoneId: ZONE,
      copied: 2,
      waitUntil: "2026-10-12T14:00:00.000Z",
    });
    expect(removed.next.join("\n")).toContain("again after 2026-10-12 14:00 UTC");
    const [approval] = first.handler.requests;
    expect(approval?.title).toBe(
      "Copy the DNS records of shopapp.com to Cloudflare and remove its old DNSSEC records",
    );
    expect(approval?.details).toContain(
      "Old DNSSEC (DS) records at Porkbun (1), removed through Porkbun's API in this run:\n  - key tag 4012, algorithm 8, digest type 2, digest 98ABCD7601",
    );
    expect(approval?.details).toContain("would take shopapp.com offline");
    expect(approval?.details).toContain(
      "Nameservers at Porkbun: not changed in this run. Run `opscrew domain connect shopapp.com` again after 2026-10-12 14:00 UTC (at least 24 hours after the public DNS stops showing the old records, plus an hour in case the registry publishes them a little longer)",
    );
    expect(await readState(first.deps)).toEqual({
      domain: DOMAIN,
      registrar: "porkbun",
      zoneId: ZONE,
      dsSeenAt: RUN_NOW,
      dsTtlSeconds: 86400,
      dsRemovedAt: RUN_NOW,
      dsGoneSeenAt: "2026-10-11T13:00:00.000Z",
    });
    expect(pb.dsRecords.get(DOMAIN)).toEqual([]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
    expect(first.deps.audit.entries.find((e) => e.action === "remove DS record")?.detail).toBe(
      `Porkbun: key tag 4012 (algorithm 8, digest type 2), before switching to zone ${ZONE}`,
    );

    // Run 2: the API lists none, but the public DNS still shows it with a full day left (the
    // registry still publishes it): no switch, and the "gone" time moves out.
    cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }], ttl: 86400 });
    const second = await cp.run({ now: "2026-10-11T14:00:00.000Z" });
    const still = await connectDomain(second.deps, { domain: DOMAIN, services: second.services });

    expect(still).toMatchObject({
      outcome: "waiting-for-ds",
      waitUntil: "2026-10-13T15:00:00.000Z",
    });
    expect(still.next.join("\n")).toContain(
      `If the public DNS still shows them then, remove them in Porkbun's dashboard (${registrarLinks("porkbun").domains}).`,
    );
    expect(second.deps.reporter.text()).toContain("The public DNS still shows old DNSSEC");
    expect((await readState(second.deps)).dsGoneSeenAt).toBe("2026-10-12T14:00:00.000Z");
    expect(events()).toEqual([
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
    ]);
    expect(second.handler.requests).toEqual([]);

    // Run 3: gone everywhere, but not yet 24 hours (plus the hour) after the public copy expired.
    cp.dns.ds.delete(DOMAIN);
    const third = await cp.run({ now: "2026-10-13T14:59:00.000Z" });
    const early = await connectDomain(third.deps, { domain: DOMAIN, services: third.services });
    expect(early).toMatchObject({
      outcome: "waiting-for-ds",
      waitUntil: "2026-10-13T15:00:00.000Z",
    });
    expect(third.handler.requests).toEqual([]);
    events();

    // Run 4, after it: only the switch is left.
    const fourth = await cp.run({ now: "2026-10-13T15:00:00.000Z" });
    const done = await connectDomain(fourth.deps, { domain: DOMAIN, services: fourth.services });

    expect(done).toMatchObject({ outcome: "connected", copied: 0, zoneId: ZONE });
    expect(events()).toEqual([
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      `porkbun listRecords ${DOMAIN}`,
      `listRecords ${ZONE}`,
      "approval domain-settings",
      `createZone acc-1 ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${ZONE_NAMESERVERS.join(",")}`,
      `activationCheck ${ZONE}`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(fourth.handler.requests[0]?.details).toContain(
      "Already in the zone, not created again: 2 records.",
    );
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
    expect(await exists(stateFile(fourth.deps))).toBe(false);
  });

  it("counts a DS record the public DNS shows but Porkbun's API does not list as old: stops before any change", async () => {
    const { cp, pb } = await porkbunHosted();
    cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }], ttl: 86400 });
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({ outcome: "waiting-for-ds", copied: 0 });
    expect(result.waitUntil).toBeUndefined();
    expect(handler.requests).toEqual([]);
    expect(cp.project.cf.zones.size).toBe(0);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
    expect(result.next[0]).toContain(
      `Remove the DS records of shopapp.com in Porkbun's dashboard (${registrarLinks("porkbun").domains}): ${dsRecordText(OLD_DS)}.`,
    );
    expect(deps.reporter.text()).toContain("Porkbun's API does not list them");
  });

  it("keeps blocking the switch when the public DS lookup fails", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp);
    const { deps: first } = await cp.run();
    await mkdir(dirname(stateFile(first)), { recursive: true });
    await writeFile(
      stateFile(first),
      JSON.stringify({
        domain: DOMAIN,
        registrar: "porkbun",
        dsSeenAt: "2026-10-01T12:00:00.000Z",
        dsRemovedAt: "2026-10-01T12:00:00.000Z",
        dsGoneSeenAt: "2026-10-01T12:00:00.000Z",
        dsTtlSeconds: 86400,
      }),
    );
    cp.dns.status = 2;
    const { deps, handler, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.hint).toContain("does not switch nameservers");
    expect(handler.requests).toEqual([]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
  });

  it("stops before any change when the API cannot remove them, then waits from when they are gone", async () => {
    const cp = await connectProject({ plan: domainTestPlan(), requirements: testRequirements() });
    const nc = cp.other("namecheap");
    nc.own(DOMAIN);
    nc.records.set(DOMAIN, [{ ...MX }, { ...TXT }]);
    // A caching resolver reports the TTL it has left (2 hours); OpsCrew still waits 24 hours.
    cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }], ttl: 7200 });
    const events = eventsOf(cp);

    // Run 1: published; Namecheap cannot remove them, so nothing changes.
    const first = await cp.run();
    const stopped = await connectDomain(first.deps, { domain: DOMAIN, services: first.services });

    expect(events()).toEqual([
      `namecheap ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `namecheap getNameservers ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
    ]);
    expect(first.handler.requests).toEqual([]);
    expect(stopped).toMatchObject({ outcome: "waiting-for-ds", copied: 0, nameservers: [] });
    expect(stopped.waitUntil).toBeUndefined();
    expect(stopped.next[0]).toBe(
      `Remove the DS records of shopapp.com in Namecheap's dashboard (${NAMECHEAP_LINK}): ${dsRecordText(OLD_DS)}. This turns DNSSEC off at the current DNS provider; shopapp.com keeps working without it.`,
    );
    expect(stopped.next[1]).toContain("24 hours later");
    expect(first.deps.reporter.text()).toContain("would take shopapp.com offline");
    expect(await readState(first.deps)).toEqual({
      domain: DOMAIN,
      registrar: "namecheap",
      dsSeenAt: RUN_NOW,
      dsTtlSeconds: 86400,
    });

    // Run 2, still published an hour later: still stopped, first sighting kept.
    const again = await cp.run({ now: "2026-10-11T13:00:00.000Z" });
    expect(
      (await connectDomain(again.deps, { domain: DOMAIN, services: again.services })).outcome,
    ).toBe("waiting-for-ds");
    expect((await readState(again.deps)).dsSeenAt).toBe(RUN_NOW);
    events();

    // The user removes them at Namecheap. Run 3 notes that they are gone and waits 24 hours.
    cp.dns.ds.delete(DOMAIN);
    const gone = await cp.run({ now: "2026-10-11T14:00:00.000Z" });
    const waiting = await connectDomain(gone.deps, { domain: DOMAIN, services: gone.services });

    expect(waiting).toMatchObject({
      outcome: "waiting-for-ds",
      waitUntil: "2026-10-12T14:00:00.000Z",
    });
    expect(waiting.next).toEqual([
      "Run `opscrew domain connect shopapp.com` again after 2026-10-12 14:00 UTC to switch the nameservers to Cloudflare; it shows what changes and asks first. Until then shopapp.com keeps working on its current DNS.",
    ]);
    expect((await readState(gone.deps)).dsGoneSeenAt).toBe("2026-10-11T14:00:00.000Z");
    expect(gone.handler.requests).toEqual([]);
    expect(events()).toEqual([
      "accounts",
      `findZone ${DOMAIN}`,
      `namecheap getNameservers ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
    ]);

    // Run 4, before 24 hours have passed since then: still waiting.
    const early = await cp.run({ now: "2026-10-12T13:59:00.000Z" });
    expect(
      (await connectDomain(early.deps, { domain: DOMAIN, services: early.services })).outcome,
    ).toBe("waiting-for-ds");
    expect(early.handler.requests).toEqual([]);

    // Run 5, after it: the copy and the switch.
    const late = await cp.run({ now: "2026-10-12T14:00:00.000Z" });
    const done = await connectDomain(late.deps, { domain: DOMAIN, services: late.services });

    expect(done).toMatchObject({ outcome: "connected", copied: 2 });
    expect(nc.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
    expect(await exists(stateFile(late.deps))).toBe(false);
  });

  it("switches right away when no DS record was ever seen", async () => {
    const cp = await connectProject();
    const nc = cp.other("namecheap");
    nc.own(DOMAIN);
    nc.records.set(DOMAIN, [{ ...MX }]);
    const { deps, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result.outcome).toBe("connected");
    expect(await exists(stateFile(deps))).toBe(false);
  });

  it("stops when the public DS lookup fails, before any change", async () => {
    const cp = await connectProject();
    const nc = cp.other("namecheap");
    nc.own(DOMAIN);
    nc.records.set(DOMAIN, [{ ...MX }]);
    cp.dns.status = 2;
    const { deps, handler, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.hint).toContain("does not switch nameservers");
    expect(handler.requests).toEqual([]);
  });

  it("does not start on another domain while one waits for its DS records", async () => {
    const { cp } = await porkbunHosted();
    const { deps, services } = await cp.run();
    await mkdir(dirname(stateFile(deps)), { recursive: true });
    await writeFile(
      stateFile(deps),
      JSON.stringify({
        domain: "oldshop.com",
        registrar: "namecheap",
        dsSeenAt: RUN_NOW,
        dsTtlSeconds: 86400,
      }),
    );

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.message).toContain("OpsCrew is still connecting oldshop.com");
    expect(error.hint).toContain("opscrew domain connect oldshop.com");
    expect(cp.project.cf.events).toEqual([]);
  });
});

describe("connectDomain: resuming", () => {
  it("copies only the records the existing zone does not have", async () => {
    const { cp } = await porkbunHosted();
    zoneExists(cp);
    cp.zones.records.set(ZONE, [{ type: "MX", name: DOMAIN, content: "mx1.mail.example.net" }]);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({ outcome: "connected", copied: 1 });
    expect(cp.project.cf.events).toContain(`createRecords ${ZONE} TXT`);
    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain(`Cloudflare zone: ${ZONE}, already in this account (pending)`);
    expect(details).toContain("Already in the zone, not created again: 1 record.");
    expect(details).toContain(
      `Nameservers at Porkbun: ${DEFAULT_NAMESERVERS.porkbun.join(" and ")} → ${ZONE_NAMESERVERS.join(" and ")}.`,
    );
  });

  it("only finishes the project files when the nameservers already point at the zone", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp);
    pb.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({
      outcome: "already-connected",
      zoneId: ZONE,
      nameservers: ZONE_NAMESERVERS,
      copied: 0,
      recorded: { plan: true, requirements: true },
    });
    expect(handler.requests).toEqual([]);
    expect(cp.project.cf.events).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `activationCheck ${ZONE}`,
      `dnssecEnabled ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(result.next.join("\n")).toContain("to turn DNSSEC on");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration?.registrar).toBe("porkbun");

    // A later run leaves files that already record the domain alone.
    const later = await cp.run({ now: "2026-10-11T18:00:00.000Z" });
    await connectDomain(later.deps, { domain: DOMAIN, services: later.services });
    expect((await readArtifact("plan", deps.paths.files.plan)).updatedAt).toBe(plan.updatedAt);
  });
});

describe("connectDomain: DNSSEC once the zone is active", () => {
  it("turns DNSSEC on after a typed approval and adds the DS record at Porkbun", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp, "active");
    pb.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    const events = eventsOf(cp);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(events()).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `dnssecEnabled ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      "approval domain-settings",
      `dnssecEnabled ${ZONE}`,
      `enableDnssec ${ZONE}`,
      `dsRecord ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `porkbun addDsRecord ${DOMAIN} 2371`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(handler.requests[0]).toMatchObject({
      kind: "domain-settings",
      title: "Turn on DNSSEC for shopapp.com",
      confirmPhrase: DOMAIN,
    });
    expect(handler.requests[0]?.details).toContain(
      "Porkbun: OpsCrew adds the zone's DS record at the registry through Porkbun's API",
    );
    expect(result).toMatchObject({ outcome: "dnssec-published", dnssec: true });
    expect(pb.dsRecords.get(DOMAIN)).toEqual([ZONE_DS_RECORD]);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration?.dnssec).toBe(true);

    // Published: a later run has nothing to ask.
    const later = await cp.run();
    const again = await connectDomain(later.deps, { domain: DOMAIN, services: later.services });
    expect(again).toMatchObject({ outcome: "already-connected", dnssec: true });
    expect(later.handler.requests).toEqual([]);
  });

  it("leaves DNSSEC off when its approval is refused", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp, "active");
    pb.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    const { deps, services } = await cp.run({ answer: () => false });

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({ outcome: "already-connected", dnssec: false });
    expect(result.next.join("\n")).toContain("DNSSEC stays off for shopapp.com");
    expect(cp.project.cf.dnssec.size).toBe(0);
    expect(pb.dsRecords.get(DOMAIN)).toBeUndefined();
  });

  it("shows the DS record to add by hand when the registrar's API cannot publish it", async () => {
    const cp = await connectProject({ plan: domainTestPlan(), requirements: testRequirements() });
    const gd = cp.other("godaddy");
    gd.own(DOMAIN);
    gd.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    zoneExists(cp, "active");
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests.map((r) => r.title)).toEqual(["Turn on DNSSEC for shopapp.com"]);
    expect(handler.requests[0]?.details).toContain(
      `GoDaddy's API cannot publish DS records, so OpsCrew shows the zone's DS record to add at ${GODADDY_LINK}`,
    );
    expect(result).toMatchObject({ outcome: "dnssec-published", dnssec: false });
    expect(result.next.join("\n")).toContain(dsRecordText(ZONE_DS));
    expect(deps.reporter.text()).toContain(dsRecordText(ZONE_DS));

    // DNSSEC is on and the API cannot publish: no approval, just the values again.
    const again = await cp.run();
    const shown = await connectDomain(again.deps, { domain: DOMAIN, services: again.services });
    expect(again.handler.requests).toEqual([]);
    expect(shown).toMatchObject({ outcome: "already-connected", dnssec: false });
    expect(shown.next.join("\n")).toContain(`at ${GODADDY_LINK} to turn DNSSEC on`);

    // The user added it at GoDaddy (the resolver shows the digest in lower case): the plan records
    // DNSSEC, and the zone's own DS record is never stale.
    cp.dns.ds.set(DOMAIN, {
      records: [{ ...ZONE_DS_RECORD, digest: ZONE_DS_RECORD.digest.toLowerCase() }],
      ttl: 3600,
    });
    const added = await cp.run();
    const recorded = await connectDomain(added.deps, { domain: DOMAIN, services: added.services });
    expect(recorded).toMatchObject({ outcome: "already-connected", dnssec: true });
    expect(added.handler.requests).toEqual([]);
    expect(added.deps.reporter.text()).not.toContain("do not match");
    const plan = await readArtifact("plan", added.deps.paths.files.plan);
    expect(plan.dns.registration?.dnssec).toBe(true);
  });
});

describe("connectDomain: stale DS records on a connected domain", () => {
  /** shopapp.com points at the zone already; DNSSEC on for the zone when `dnssec`. */
  async function connectedAt(status: "active" | "pending", dnssec: boolean) {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp, status);
    pb.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    if (dnssec) cp.project.cf.dnssec.add(ZONE);
    return { cp, pb };
  }

  it("removes them through Porkbun's API after a typed approval; the zone's own DS stays", async () => {
    const { cp, pb } = await connectedAt("active", true);
    // the zone's DS (digest in lower case: still the same record) and an old one
    const own = { ...ZONE_DS_RECORD, digest: ZONE_DS_RECORD.digest.toLowerCase() };
    pb.dsRecords.set(DOMAIN, [own, { ...OLD_DS }]);
    const events = eventsOf(cp);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(events()).toEqual([
      `porkbun ownsDomain ${DOMAIN}`,
      "accounts",
      `findZone ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `dnssecEnabled ${ZONE}`,
      `dsRecord ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      "approval domain-settings",
      `porkbun removeDsRecord ${DOMAIN} 4012`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({
      kind: "domain-settings",
      title: "Remove the stale DNSSEC records of shopapp.com",
      confirmPhrase: DOMAIN,
    });
    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain(
      `Stale DNSSEC (DS) records at Porkbun (1), removed through Porkbun's API: they do not match the zone's DNSSEC key, so resolvers that check DNSSEC cannot resolve shopapp.com while they are published.\n  - ${dsRecordText(OLD_DS)}`,
    );
    expect(details).not.toContain("key tag 2371");
    expect(pb.dsRecords.get(DOMAIN)).toEqual([own]);
    expect(result).toMatchObject({ outcome: "dnssec-published", dnssec: true });
    expect(deps.audit.entries.find((e) => e.action === "remove DS record")?.detail).toBe(
      `Porkbun: key tag 4012 (algorithm 8, digest type 2), stale: not the DS record of zone ${ZONE}`,
    );
  });

  it("removes them in the same approval that turns DNSSEC on, before the new DS is added", async () => {
    const { cp, pb } = await connectedAt("active", false);
    pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const events = eventsOf(cp);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(events().slice(4)).toEqual([
      `dnssecEnabled ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `dns DS ${DOMAIN}`,
      "approval domain-settings",
      `porkbun removeDsRecord ${DOMAIN} 4012`,
      `dnssecEnabled ${ZONE}`,
      `enableDnssec ${ZONE}`,
      `dsRecord ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `porkbun addDsRecord ${DOMAIN} 2371`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    expect(handler.requests.map((r) => r.title)).toEqual(["Turn on DNSSEC for shopapp.com"]);
    expect(handler.requests[0]?.details).toContain(dsRecordText(OLD_DS));
    expect(handler.requests[0]?.details).toContain("OpsCrew turns DNSSEC on");
    expect(pb.dsRecords.get(DOMAIN)).toEqual([ZONE_DS_RECORD]);
    expect(result).toMatchObject({ outcome: "dnssec-published", dnssec: true });
  });

  it("asks while the zone is still pending, and keeps them (with a warning) when refused", async () => {
    const { cp, pb } = await connectedAt("pending", false);
    pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const { deps, handler, services } = await cp.run({ answer: () => false });

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests.map((r) => r.title)).toEqual([
      "Remove the stale DNSSEC records of shopapp.com",
    ]);
    expect(pb.dsRecords.get(DOMAIN)).toEqual([OLD_DS]);
    expect(result.outcome).toBe("already-connected");
    const next = result.next.join("\n");
    expect(next).toContain(
      `shopapp.com has DNSSEC (DS) records at Porkbun that do not match its Cloudflare zone: ${dsRecordText(OLD_DS)}.`,
    );
    expect(next).toContain("may fail to resolve for visitors whose resolver checks DNSSEC");
    expect(deps.reporter.text()).toContain("do not match its Cloudflare zone");
  });

  it("warns with the dashboard link when the registrar's API cannot remove them", async () => {
    const cp = await connectProject({ plan: domainTestPlan(), requirements: testRequirements() });
    const gd = cp.other("godaddy");
    gd.own(DOMAIN);
    gd.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    zoneExists(cp, "pending");
    cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }], ttl: 86400 });
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests).toEqual([]);
    const warning = `shopapp.com has DNSSEC (DS) records at GoDaddy that do not match its Cloudflare zone: ${dsRecordText(OLD_DS)}. Until they are removed in GoDaddy's dashboard (${GODADDY_LINK}), shopapp.com may fail to resolve for visitors whose resolver checks DNSSEC.`;
    expect(result.next).toContain(warning);
    expect(deps.reporter.text()).toContain(`warn: ${warning}`);
    expect(result).toMatchObject({ outcome: "already-connected", dnssec: false });
  });

  it("never removes one through the API when it shares the zone DS record's key tag", async () => {
    const { cp, pb } = await connectedAt("active", true);
    // Same key tag, other digest type: removing by key tag would also remove the zone's record.
    const sameTag = { ...ZONE_DS_RECORD, digestType: 1, digest: "0123ABCD" };
    pb.dsRecords.set(DOMAIN, [{ ...ZONE_DS_RECORD }, sameTag]);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests).toEqual([]);
    expect(cp.project.cf.events).not.toContain(`porkbun removeDsRecord ${DOMAIN} 2371`);
    expect(result.next.join("\n")).toContain(
      `that do not match its Cloudflare zone: ${dsRecordText(sameTag)}.`,
    );
    expect(result).toMatchObject({ outcome: "already-connected", dnssec: true });
  });

  it("calls nothing stale when DNSSEC is on but the zone's DS record cannot be read, and says so", async () => {
    const { cp, pb } = await connectedAt("active", true);
    pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const { deps, handler, services } = await cp.run();
    services.zones = { ...(services.zones as DomainZoneApi), dsRecord: async () => undefined };

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests).toEqual([]);
    expect(pb.dsRecords.get(DOMAIN)).toEqual([OLD_DS]);
    const next = result.next.join("\n");
    expect(next).toContain(
      `DNSSEC is on for the Cloudflare zone of shopapp.com, but Cloudflare did not return its DS record, so OpsCrew could not check the DS records published for shopapp.com (${dsRecordText(OLD_DS)}) against it; run \`opscrew domain connect shopapp.com\` again later.`,
    );
    expect(next).not.toContain("do not match");
    expect(deps.reporter.text()).toContain("Cloudflare did not return its DS record");
    expect(result.outcome).toBe("already-connected");
  });
});

describe("connectDomain: records the existing zone already has", () => {
  it("lists zone records the registrar does not have, and the proxied ones, in the approval", async () => {
    const { cp, pb } = await porkbunHosted();
    pb.records.set(DOMAIN, [
      { type: "A", name: DOMAIN, content: "192.0.2.10", ttl: 600 },
      { ...MX },
      { ...TXT },
    ]);
    zoneExists(cp);
    cp.zones.records.set(ZONE, [
      { type: "A", name: DOMAIN, content: "192.0.2.10", proxied: true },
      { type: "TXT", name: `_verify.${DOMAIN}`, content: '"token-one"', proxied: false },
    ]);
    const { deps, handler, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain("Already in the zone, not created again: 1 record.");
    expect(details).toContain(
      `Already in the Cloudflare zone, not at Porkbun; these are also served after the switch (1):\n  TXT _verify.${DOMAIN} "token-one"`,
    );
    expect(details).toContain(
      `Proxied by Cloudflare (1); only web traffic reaches these names; mail, SSH and other services through them stop working until proxying is turned off in Cloudflare:\n  A ${DOMAIN} 192.0.2.10`,
    );
    expect(result).toMatchObject({ outcome: "connected", copied: 2 });
    expect(result.next.join("\n")).toContain(`Cloudflare proxies A ${DOMAIN} 192.0.2.10`);
  });

  it.each([
    [
      "a CNAME next to an A record",
      { type: "CNAME", name: `www.${DOMAIN}`, content: "hosting.example.net" },
      { type: "A", name: `www.${DOMAIN}`, content: "192.0.2.20" },
      `CNAME www.${DOMAIN} hosting.example.net is already in the Cloudflare zone, but the current DNS has A www.${DOMAIN} 192.0.2.20; Cloudflare does not allow a CNAME next to an A, AAAA or another CNAME record on the same name`,
    ],
    [
      "an A record next to a CNAME",
      { type: "A", name: `www.${DOMAIN}`, content: "198.51.100.7" },
      { type: "CNAME", name: `www.${DOMAIN}`, content: "hosting.example.net" },
      `A www.${DOMAIN} 198.51.100.7 is already in the Cloudflare zone, but the current DNS has CNAME www.${DOMAIN} hosting.example.net; Cloudflare does not allow a CNAME next to an A or AAAA record on the same name`,
    ],
    [
      "another address for the same name",
      { type: "A", name: DOMAIN, content: "198.51.100.7" },
      { type: "A", name: DOMAIN, content: "203.0.113.5" },
      `A ${DOMAIN} 198.51.100.7 is already in the Cloudflare zone, but the current DNS answers 203.0.113.5 there; after the switch both answers would be served`,
    ],
    [
      "other mail servers for the same name",
      { type: "MX", name: DOMAIN, content: "mx.other-mail.example", priority: 10 },
      { type: "A", name: DOMAIN, content: "192.0.2.10" },
      `the Cloudflare zone already has other mail servers for ${DOMAIN}: mx.other-mail.example, next to the current ones (mx1.mail.example.net); after the switch mail would be split between them`,
    ],
    [
      "a second SPF record for the same name",
      { type: "TXT", name: DOMAIN, content: '"v=spf1 include:_spf.other.example -all"' },
      { ...TXT },
      `the Cloudflare zone already has another SPF record for ${DOMAIN} ("v=spf1 include:_spf.other.example -all") next to the current one ("v=spf1 include:_spf.mail.example.net ~all"); with more than one SPF record on a name, mail checks fail`,
    ],
  ])("stops before any change for %s", async (_case, inZone, current, clash) => {
    const { cp, pb } = await porkbunHosted();
    pb.records.set(DOMAIN, [{ ...current }, { ...MX }]);
    zoneExists(cp);
    cp.zones.records.set(ZONE, [{ ...inZone }]);
    const { deps, handler, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The Cloudflare zone of ${DOMAIN} already has records that clash with its current DNS, so OpsCrew changed nothing: ${clash}.`,
    );
    expect(error.hint).toContain("Delete the clashing record in the Cloudflare dashboard");
    expect(error.hint).toContain("change the current record at Porkbun to match the zone's");
    expect(handler.requests).toEqual([]);
    expect(cp.zones.created).toEqual([]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
  });
});

describe("connectDomain: the copy must be complete before the switch", () => {
  it("never switches after a failed batch, and the rerun creates only the missing records", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp);
    cp.zones.records.set(ZONE, [{ type: "MX", name: DOMAIN, content: "mx1.mail.example.net" }]);
    cp.zones.createFailure = (call) =>
      call === 1 ? new OpsCrewError("PROVIDER_ERROR", "Cloudflare refused the batch.") : undefined;
    const first = await cp.run();

    const error = await caught(
      connectDomain(first.deps, { domain: DOMAIN, services: first.services }),
    );

    expect(error.message).toBe(
      "OpsCrew could not finish moving shopapp.com to Cloudflare: Cloudflare refused the batch.",
    );
    expect(cp.project.cf.events.some((e) => e.includes("setNameservers"))).toBe(false);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);

    const second = await cp.run();
    const result = await connectDomain(second.deps, { domain: DOMAIN, services: second.services });

    expect(result).toMatchObject({ outcome: "connected", copied: 1 });
    expect(cp.zones.created).toEqual([
      { zoneId: ZONE, records: [expect.objectContaining({ type: "TXT" })] },
    ]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("stops before the switch when the batch answer reports fewer records and one is missing", async () => {
    const { cp, pb } = await porkbunHosted();
    cp.zones.dropLast = true;
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      'OpsCrew could not finish moving shopapp.com to Cloudflare: Cloudflare confirmed 1 of the 2 records, and the zone lacks TXT shopapp.com "v=spf1 include:_spf.mail.example.net ~all", so OpsCrew changed nothing else (the nameservers still point at the current DNS).',
    );
    expect(error.hint).toContain("again: it checks what is done and continues from there");
    expect(cp.project.cf.events).toContain(`listRecords ${ZONE}`);
    expect(cp.project.cf.events.some((e) => e.includes("setNameservers"))).toBe(false);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
  });

  it("switches when a short count is only a counting slip: the zone has every record", async () => {
    const { cp, pb } = await porkbunHosted();
    cp.zones.undercount = true;
    const { deps, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({ outcome: "connected", copied: 2 });
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });
});

describe("connectDomain: an unreadable note about an earlier run", () => {
  it.each([
    ["garbage", "{not json"],
    ["the wrong shape", JSON.stringify({ domain: DOMAIN, registrar: "somewhere" })],
    [
      "a wait below 24 hours",
      JSON.stringify({
        domain: DOMAIN,
        registrar: "porkbun",
        dsRemovedAt: RUN_NOW,
        dsTtlSeconds: 3600,
      }),
    ],
  ])("stops on %s before any registrar or Cloudflare call", async (_case, content) => {
    const { cp } = await porkbunHosted();
    const { deps, handler, services } = await cp.run();
    await mkdir(dirname(stateFile(deps)), { recursive: true });
    await writeFile(stateFile(deps), content);

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("cannot read its note about connecting a domain");
    expect(error.hint).toContain("48 hours");
    expect(cp.project.cf.events).toEqual([]);
    expect(handler.requests).toEqual([]);
  });
});

describe("connectDomain: other cases", () => {
  it("stops when the zone is in another Cloudflare account, naming --account", async () => {
    const { cp, pb } = await porkbunHosted();
    zoneExists(cp, "pending", "acc-2");
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.message).toBe(
      "A Cloudflare zone for shopapp.com already exists in another Cloudflare account (acc-2), not in Shop (acc-1). Nothing was changed.",
    );
    expect(error.hint).toContain(`opscrew domain connect ${DOMAIN} --account acc-2`);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
  });

  it("stops when the domain already uses Cloudflare nameservers this token cannot see", async () => {
    const { cp, pb } = await porkbunHosted();
    pb.nameservers.set(DOMAIN, ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    const { deps, services } = await cp.run();

    const error = await caught(connectDomain(deps, { domain: DOMAIN, services }));

    expect(error.message).toContain("already point at Cloudflare");
    expect(error.hint).toContain("another Cloudflare account");
  });

  it("lists how ALIAS maps and what is not copied before the approval", async () => {
    const cp = await connectProject();
    const nc = cp.other("namecheap");
    nc.own(DOMAIN);
    nc.records.set(DOMAIN, [
      { type: "ALIAS", name: DOMAIN, content: "shops.example.net" },
      { type: "URL", name: `www.${DOMAIN}`, content: "https://shopapp.com" },
      {
        type: "EMAIL-FORWARDING",
        name: DOMAIN,
        content:
          "Namecheap email forwarding (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing)",
      },
    ]);
    const { deps, handler, services } = await cp.run();

    await connectDomain(deps, { domain: DOMAIN, services });

    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain(
      "  CNAME shopapp.com shops.example.net (the ALIAS record, as a CNAME: Cloudflare flattens a CNAME at the apex, so it answers like ALIAS)",
    );
    expect(details).toContain(
      "Not copied (2); these stop working when the nameservers switch unless you recreate them:",
    );
    expect(details).toContain(
      "  - The URL record for www.shopapp.com is a registrar redirect or forwarding record",
    );
    expect(details).toContain(
      "  - Mail for shopapp.com: Namecheap email forwarding (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing).",
    );
  });

  it("asks before replacing another domain in the plan; refused, the plan keeps it", async () => {
    const { cp, pb } = await porkbunHosted({
      plan: domainTestPlan({ domain: "oldshop.com" }),
      requirements: testRequirements("oldshop.com"),
    });
    const { deps, handler, services } = await cp.run({
      answer: (request) => request.kind === "domain-settings",
    });

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests.map((r) => [r.kind, r.title])).toEqual([
      ["domain-settings", "Move the DNS of shopapp.com to Cloudflare"],
      ["repo-write", "Use shopapp.com instead of oldshop.com in opscrew/plan.yaml"],
    ]);
    expect(handler.requests[0]?.details).toContain(
      "The project uses oldshop.com today; after the switch OpsCrew asks before it records shopapp.com instead:",
    );
    expect(result).toMatchObject({
      outcome: "connected",
      recorded: { plan: false, requirements: false },
    });
    expect(result.next.join("\n")).toContain("opscrew dns --domain shopapp.com");
    expect(deps.reporter.text()).toContain("The plan still uses oldshop.com");
    expect((await readArtifact("plan", deps.paths.files.plan)).dns.domain).toBe("oldshop.com");
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("records the plain fallbacks when the registrar returns no registration details", async () => {
    const { cp, pb } = await porkbunHosted();
    pb.failures.getDomain = () => new Error("Porkbun is unavailable");
    const { deps, services } = await cp.run();

    const result = await connectDomain(deps, { domain: DOMAIN, services });

    expect(result.outcome).toBe("connected");
    expect(deps.reporter.text()).toContain(
      "OpsCrew could not read the registration details of shopapp.com from Porkbun (Porkbun is unavailable)",
    );
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toEqual({
      registrar: "porkbun",
      autoRenew: false,
      privacy: false,
      dnssec: false,
    });
  });
});
