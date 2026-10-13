/**
 * A fake Cloudflare (accounts, registrar, extensions, zones, public DNS), fake Porkbun, Namecheap
 * and GoDaddy accounts, and a temp project for the `opscrew domain` command tests. Nothing here
 * reaches the network. For tests only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DomainAccount,
  DomainServices,
  DomainZone,
  OtherRegistrarId,
  ZoneRecord,
} from "@opscrew/agents";
import type {
  DomainCheck,
  DsRecord,
  FetchLike,
  Money,
  RegisteredDomain,
  Registrar,
  RegistrarCapabilities,
  RegistrarDnsRecord,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { withDeployServices } from "../deploy-services";
import { projectContext, ScriptedPrompts, type TempProject, tempProject } from "./harness";

/** The Cloudflare token of the domain tests (generated, never a real one). */
export const CF_TOKEN = fakeSecret("cloudflare-token", "cli-domain-tests");

export const usd = (amount: number): Money => ({ amount, currency: "USD" });

/** A standard, registrable name at the given prices. */
export function buyable(domain: string, firstYear = 10.44, renewal = firstYear): DomainCheck {
  return {
    domain,
    registrable: true,
    tier: "standard",
    firstYear: usd(firstYear),
    renewal: usd(renewal),
  };
}

/** The nameservers Cloudflare assigns to every fake zone. */
export const CF_NAMESERVERS: readonly string[] = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

/** The DS record of every fake Cloudflare zone with DNSSEC on (fake values). */
export const ZONE_DS: DsRecord = {
  keyTag: 2371,
  algorithm: 13,
  digestType: 2,
  digest: "AB12CD34EF",
};

/** An old DS record of a domain's current DNS provider (fake values). */
export const OLD_DS: DsRecord = { keyTag: 4012, algorithm: 8, digestType: 2, digest: "98ABCD7601" };

/** The nameservers a fake registrar account serves a domain with before it moves to Cloudflare. */
export const REGISTRAR_NAMESERVERS: Readonly<Record<OtherRegistrarId, readonly string[]>> = {
  porkbun: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"],
  namecheap: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
  godaddy: ["ns01.domaincontrol.com", "ns02.domaincontrol.com"],
};

/** The capabilities the real adapters declare. */
const CAPABILITIES: Readonly<Record<OtherRegistrarId, RegistrarCapabilities>> = {
  porkbun: {
    purchase: true,
    chooseYears: false,
    nameservers: true,
    records: true,
    dnssec: true,
    autoRenew: true,
  },
  namecheap: {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  },
  godaddy: {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  },
};

/**
 * A Porkbun, Namecheap or GoDaddy account as the domain commands see it: live checks and quotes
 * from `checks`, synchronous purchases, nameservers, DNS records and (Porkbun) DS records. Calls
 * are appended to the shared `events` list, prefixed with the registrar id.
 */
export class FakeOtherRegistrar {
  readonly capabilities: RegistrarCapabilities;
  readonly checks = new Map<string, DomainCheck>();
  readonly domains = new Map<string, RegisteredDomain>();
  readonly nameservers = new Map<string, string[]>();
  /** Records the registrar's DNS serves (absent: it does not host the domain's DNS). */
  readonly records = new Map<string, RegistrarDnsRecord[]>();
  readonly dsRecords = new Map<string, DsRecord[]>();
  readonly registerCalls: RegistrationRequest[] = [];
  readonly autoRenewCalls: { domain: string; on: boolean }[] = [];

  constructor(
    readonly id: OtherRegistrarId,
    private readonly events: string[],
    capabilities: Partial<RegistrarCapabilities> = {},
  ) {
    this.capabilities = { ...CAPABILITIES[id], ...capabilities };
  }

  /** Marks the domain as registered in the account, served by the registrar's nameservers. */
  own(domain: string, details: Partial<RegisteredDomain> = {}): void {
    this.domains.set(domain, {
      domain,
      registrar: this.id,
      createdAt: "2026-01-02T03:04:05Z",
      expiresAt: "2027-01-02T03:04:05Z",
      autoRenew: true,
      locked: true,
      privacy: true,
      ...details,
    });
    if (!this.nameservers.has(domain)) {
      this.nameservers.set(domain, [...REGISTRAR_NAMESERVERS[this.id]]);
    }
  }

  api(): Registrar {
    const log = (event: string) => this.events.push(`${this.id} ${event}`);
    const registrar: Registrar = {
      id: this.id,
      capabilities: this.capabilities,
      check: async (domains) => {
        log(`check ${domains.join(",")}`);
        return domains.flatMap((d) => {
          const answer = this.checks.get(d);
          return answer === undefined ? [] : [{ ...answer }];
        });
      },
      suggest: async () => [],
      quote: async (domain) => {
        log(`quote ${domain}`);
        const check = this.checks.get(domain);
        if (check?.firstYear === undefined) throw new Error(`${domain} has no price`);
        return { price: check.firstYear, ...(check.renewal ? { renewal: check.renewal } : {}) };
      },
      registrationStatus: async (domain) =>
        this.domains.has(domain) ? { domain, state: "succeeded" } : undefined,
      register: async (request) => {
        log(`register ${request.domain}`);
        this.registerCalls.push({ ...request });
        this.own(request.domain, {
          createdAt: "2026-10-11T12:00:05Z",
          expiresAt: "2027-10-11T12:00:05Z",
          autoRenew: request.autoRenew,
        });
        return { domain: request.domain, state: "succeeded" };
      },
      getDomain: async (domain) => {
        const found = this.domains.get(domain);
        return found === undefined ? undefined : { ...found };
      },
      setAutoRenew: async (domain, on) => {
        log(`setAutoRenew ${domain} ${on ? "on" : "off"}`);
        this.autoRenewCalls.push({ domain, on });
        const found = this.domains.get(domain);
        if (found === undefined) throw new Error(`no registration of ${domain}`);
        const updated = { ...found, autoRenew: on };
        this.domains.set(domain, updated);
        return { ...updated };
      },
      ownsDomain: async (domain) => this.domains.has(domain),
      getNameservers: async (domain) => [...(this.nameservers.get(domain) ?? [])],
      setNameservers: async (domain, nameservers) => {
        log(`setNameservers ${domain} ${nameservers.join(",")}`);
        this.nameservers.set(domain, [...nameservers]);
      },
      listRecords: async (domain) => this.records.get(domain)?.map((r) => ({ ...r })),
    };
    if (this.capabilities.dnssec) {
      registrar.listDsRecords = async (domain) =>
        (this.dsRecords.get(domain) ?? []).map((r) => ({ ...r }));
      registrar.addDsRecord = async (domain, ds) => {
        log(`addDsRecord ${domain} ${ds.keyTag}`);
        this.dsRecords.set(domain, [...(this.dsRecords.get(domain) ?? []), { ...ds }]);
      };
      registrar.removeDsRecord = async (domain, keyTag) => {
        log(`removeDsRecord ${domain} ${keyTag}`);
        this.dsRecords.set(
          domain,
          (this.dsRecords.get(domain) ?? []).filter((r) => r.keyTag !== keyTag),
        );
      };
    }
    return registrar;
  }
}

/** Cloudflare's content format for a created record (as its record listing returns it). */
function zoneContent(record: { type: string; content?: string; data?: Record<string, unknown> }) {
  const data = record.data ?? {};
  if (record.type === "SRV") return `${data.weight} ${data.port} ${data.target}`;
  if (record.type === "CAA") return `${data.flags} ${data.tag} "${data.value}"`;
  return record.content ?? "";
}

/**
 * Cloudflare as the domain commands see it. A purchase succeeds at once; every call is appended
 * to `events`. Other registrars (`other`) must be added before `context()` is called.
 */
export class FakeCloudflare {
  readonly events: string[] = [];
  accounts: DomainAccount[] = [{ id: "acc-1", name: "Shop" }];
  readonly checks = new Map<string, DomainCheck>();
  suggestions: DomainCheck[] = [];
  readonly registrations = new Map<string, RegistrationStatus>();
  readonly domains = new Map<string, RegisteredDomain>();
  readonly zones = new Map<string, DomainZone>();
  /** Zone ids whose DNSSEC is off (every other zone has it on, with {@link ZONE_DS}). */
  readonly dnssecOff = new Set<string>();
  /** Records in each zone, by zone id. */
  readonly zoneRecords = new Map<string, ZoneRecord[]>();
  /** What Cloudflare's scan of the public DNS finds, by domain. */
  readonly scans = new Map<string, RegistrarDnsRecord[]>();
  /** DS records the public DNS shows, by domain. */
  readonly publicDs = new Map<string, DsRecord[]>();
  readonly others = new Map<OtherRegistrarId, FakeOtherRegistrar>();
  readonly registerCalls: { accountId: string; request: RegistrationRequest }[] = [];
  readonly autoRenewCalls: { domain: string; on: boolean }[] = [];
  /** Thrown by `check` instead of answering (for the error and redaction tests). */
  checkError?: Error;

  constructor() {
    this.checks.set("shopapp.com", buyable("shopapp.com"));
  }

  /** A Porkbun, Namecheap or GoDaddy account with API credentials. */
  other(id: OtherRegistrarId, capabilities?: Partial<RegistrarCapabilities>): FakeOtherRegistrar {
    const fake = new FakeOtherRegistrar(id, this.events, capabilities);
    this.others.set(id, fake);
    return fake;
  }

  /** Cloudflare's public DNS over HTTPS (DS lookups); any other request fails the test. */
  readonly fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== "https://cloudflare-dns.com/dns-query") {
      throw new Error(`Unexpected network call in a test: ${url.href}`);
    }
    const name = url.searchParams.get("name") ?? "";
    this.events.push(`dns ${url.searchParams.get("type")} ${name}`);
    const records = this.publicDs.get(name) ?? [];
    return Response.json({
      Status: 0,
      ...(records.length === 0
        ? {}
        : {
            Answer: records.map((r) => ({
              name: `${name}.`,
              type: 43,
              TTL: 3600,
              data: `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`,
            })),
          }),
    });
  };

  /** Marks the domain as registered on the account. */
  own(domain: string, details: Partial<RegisteredDomain> = {}): void {
    this.registrations.set(domain, { domain, state: "succeeded" });
    this.domains.set(domain, {
      domain,
      registrar: "cloudflare",
      createdAt: "2026-01-02T03:04:05Z",
      expiresAt: "2027-01-02T03:04:05Z",
      autoRenew: true,
      locked: true,
      privacy: true,
      ...details,
    });
  }

  registrar(accountId: string): Registrar {
    return {
      id: "cloudflare",
      check: async (domains) => {
        this.events.push(`check ${domains.join(",")}`);
        if (this.checkError !== undefined) throw this.checkError;
        return domains.flatMap((d) => {
          const answer = this.checks.get(d);
          return answer === undefined ? [] : [{ ...answer }];
        });
      },
      suggest: async (query) => {
        this.events.push(`suggest ${query}`);
        return this.suggestions.map((s) => ({ ...s }));
      },
      registrationStatus: async (domain) => {
        const found = this.registrations.get(domain);
        return found === undefined ? undefined : { ...found };
      },
      register: async (request) => {
        this.events.push(`register ${request.domain}`);
        this.registerCalls.push({ accountId, request: { ...request } });
        this.own(request.domain, {
          createdAt: "2026-10-11T12:00:05Z",
          expiresAt: `${2026 + request.years}-10-11T12:00:05Z`,
          autoRenew: request.autoRenew,
          privacy: request.privacy,
        });
        return { domain: request.domain, state: "succeeded" };
      },
      getDomain: async (domain) => {
        const found = this.domains.get(domain);
        return found === undefined ? undefined : { ...found };
      },
      setAutoRenew: async (domain, on) => {
        this.events.push(`setAutoRenew ${domain} ${on ? "on" : "off"}`);
        this.autoRenewCalls.push({ domain, on });
        const found = this.domains.get(domain);
        if (found === undefined) throw new Error(`no registration of ${domain}`);
        const updated = { ...found, autoRenew: on };
        this.domains.set(domain, updated);
        return { ...updated };
      },
    };
  }

  services(): DomainServices {
    const registrars = Object.fromEntries(
      [...this.others].map(([id, fake]) => [id, fake.api()] as const),
    );
    return {
      accounts: async () => {
        this.events.push("accounts");
        return this.accounts.map((a) => ({ ...a }));
      },
      registrar: (accountId) => this.registrar(accountId),
      ...(this.others.size === 0 ? {} : { registrars }),
      extension: async (_accountId, tld) => ({
        contactExtensionsRequired: ["us", "uk", "ca"].includes(tld),
      }),
      zones: {
        findZone: async (name) => {
          const zone = this.zones.get(name);
          return zone === undefined ? undefined : { ...zone };
        },
        createZone: async (_accountId, name) => {
          const zone = this.zones.get(name) ?? {
            id: `zone-${name}`,
            name,
            status: "pending",
            nameServers: [...CF_NAMESERVERS],
          };
          if (!this.zones.has(name)) this.events.push(`createZone ${name}`);
          this.zones.set(name, zone);
          return { ...zone };
        },
        enableDnssec: async (zoneId) => {
          this.events.push(`enableDnssec ${zoneId}`);
          this.dnssecOff.delete(zoneId);
        },
        dnssecEnabled: async (zoneId) => !this.dnssecOff.has(zoneId),
        dsRecord: async (zoneId) => (this.dnssecOff.has(zoneId) ? undefined : { ...ZONE_DS }),
        activationCheck: async (zoneId) => {
          this.events.push(`activationCheck ${zoneId}`);
          return { requested: true };
        },
        listRecords: async (zoneId) => (this.zoneRecords.get(zoneId) ?? []).map((r) => ({ ...r })),
        createRecords: async (zoneId, records) => {
          this.events.push(`createRecords ${zoneId} ${records.map((r) => r.type).join(",")}`);
          const zone = this.zoneRecords.get(zoneId) ?? [];
          zone.push(
            ...records.map((r) => ({
              type: r.type,
              name: r.name,
              content: zoneContent(r),
              ...(r.type === "MX" && r.priority !== undefined ? { priority: r.priority } : {}),
            })),
          );
          this.zoneRecords.set(zoneId, zone);
          return records.length;
        },
        scanRecords: async (zoneId) => {
          this.events.push(`scanRecords ${zoneId}`);
          const name = [...this.zones.values()].find((z) => z.id === zoneId)?.name ?? "";
          return (this.scans.get(name) ?? []).map((r) => ({ ...r }));
        },
      },
      sleep: async () => {},
      now: () => 0,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    };
  }
}

export interface DomainTestProject {
  project: TempProject;
  cf: FakeCloudflare;
  /** A context for one run: scripted prompt answers, interactive or not. */
  context(options?: {
    interactive?: boolean;
    answers?: unknown[];
    token?: string | null;
  }): ReturnType<typeof projectContext> & { prompts: ScriptedPrompts };
  /** Writes OpsCrew's note about an earlier, unfinished purchase. */
  writePurchaseRecord(record: Record<string, unknown>): Promise<string>;
  /** `<projectHome>/domain-purchase.json`. */
  readonly recordFile: string;
}

/** An empty temp project, a fake Cloudflare and contexts wired to both. */
export async function domainTestProject(): Promise<DomainTestProject> {
  const project = await tempProject();
  const cf = new FakeCloudflare();
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const recordFile = path.join(paths.projectHomeDir, "domain-purchase.json");
  return {
    project,
    cf,
    recordFile,
    context(options = {}) {
      const token = options.token === undefined ? CF_TOKEN : options.token;
      const prompts = new ScriptedPrompts(options.answers ?? []);
      const ctx = projectContext(
        {
          ...project,
          env: { ...project.env, ...(token === null ? {} : { CLOUDFLARE_API_TOKEN: token }) },
        },
        { interactive: options.interactive ?? false, services: { prompts, fetch: cf.fetch } },
      );
      withDeployServices(ctx, { domain: cf.services() });
      return Object.assign(ctx, { prompts });
    },
    async writePurchaseRecord(record) {
      await mkdir(path.dirname(recordFile), { recursive: true });
      await writeFile(recordFile, JSON.stringify(record));
      return recordFile;
    },
  };
}
