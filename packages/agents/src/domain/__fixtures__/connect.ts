import type { CloudflareRecordInput } from "@opscrew/connector-cloudflare";
import type {
  DsRecord,
  FetchLike,
  Registrar,
  RegistrarCapabilities,
  RegistrarDnsRecord,
} from "@opscrew/contracts";
import { DNS_OVER_HTTPS_URL } from "../../shared";
import type { OtherRegistrarId } from "../registrars";
import type { DomainZoneApi, ZoneRecord } from "../types";
import { type DomainProject, domainProject, type Run, type RunOptions } from "./fakes";
import type { FakeRegistrar } from "./registrars";

/** An old DS record of the domain's current DNS provider (fake values). */
export const OLD_DS: DsRecord = {
  keyTag: 4012,
  algorithm: 8,
  digestType: 2,
  digest: "98ABCD7601",
};

/** Cloudflare's content format for a created record (as `GET dns_records` returns it). */
function zoneContent(record: CloudflareRecordInput): string {
  const data = record.data ?? {};
  if (record.type === "SRV") return `${data.weight} ${data.port} ${data.target}`;
  if (record.type === "CAA") return `${data.flags} ${data.tag} "${data.value}"`;
  return record.content ?? "";
}

/**
 * Zone records and Cloudflare's scan on top of the Cloudflare fake's zones, logging to the shared
 * `events` list.
 */
export class FakeZoneRecords {
  /** Records in each zone, by zone id. */
  readonly records = new Map<string, ZoneRecord[]>();
  /** What Cloudflare's scan finds, by domain. */
  readonly scans = new Map<string, RegistrarDnsRecord[]>();
  /** Every successful `createRecords` call. */
  readonly created: { zoneId: string; records: CloudflareRecordInput[] }[] = [];
  /** Throws instead of creating (n = 1-based call): like the batch API, nothing of it is created. */
  createFailure?: (call: number) => Error | undefined;
  /** Creates all but the last record of a call and answers with that count (a short batch). */
  dropLast = false;
  /** Creates every record but answers with one fewer (a wrong count; the zone has them all). */
  undercount = false;
  private createCalls = 0;

  constructor(
    private readonly events: string[],
    private readonly base: DomainZoneApi,
  ) {}

  api(): DomainZoneApi {
    return {
      ...this.base,
      listRecords: async (zoneId) => {
        this.events.push(`listRecords ${zoneId}`);
        return (this.records.get(zoneId) ?? []).map((r) => ({ ...r }));
      },
      createRecords: async (zoneId, records) => {
        this.events.push(`createRecords ${zoneId} ${records.map((r) => r.type).join(",")}`);
        const error = this.createFailure?.(++this.createCalls);
        if (error !== undefined) throw error;
        const made = this.dropLast ? records.slice(0, -1) : records;
        this.created.push({ zoneId, records: made.map((r) => ({ ...r })) });
        const zone = this.records.get(zoneId) ?? [];
        zone.push(
          ...made.map((r) => ({
            type: r.type,
            name: r.name,
            content: zoneContent(r),
            // Cloudflare's listing returns the MX priority on its own.
            ...(r.type === "MX" && r.priority !== undefined ? { priority: r.priority } : {}),
          })),
        );
        this.records.set(zoneId, zone);
        return this.undercount ? made.length - 1 : made.length;
      },
      scanRecords: async (zoneId) => {
        this.events.push(`scanRecords ${zoneId}`);
        return (this.scans.get(zoneId.replace(/^zone-/, "")) ?? []).map((r) => ({ ...r }));
      },
    };
  }
}

/** The public DNS as Cloudflare's DNS over HTTPS answers it: DS records by domain. */
export class FakePublicDns {
  readonly ds = new Map<string, { records: DsRecord[]; ttl: number }>();
  /** DNS status of every answer (0 NOERROR, 2 SERVFAIL …). */
  status = 0;

  constructor(private readonly events: string[]) {}

  readonly fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== DNS_OVER_HTTPS_URL) {
      throw new Error(`Unexpected network call in a test: ${url.href}`);
    }
    const name = url.searchParams.get("name") ?? "";
    this.events.push(`dns ${url.searchParams.get("type")} ${name}`);
    const found = this.ds.get(name);
    const answer =
      found === undefined || found.records.length === 0
        ? {}
        : {
            Answer: found.records.map((r) => ({
              name: `${name}.`,
              type: 43,
              TTL: found.ttl,
              data: `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`,
            })),
          };
    return Response.json({ Status: this.status, ...answer });
  };
}

/** The registrar as `connect` sees it: ownership logged; Porkbun can remove DS records. */
function connectApi(fake: FakeRegistrar, events: string[], ownsError?: Error): Registrar {
  const base = fake.api();
  const owns = base.ownsDomain;
  const api: Registrar = {
    ...base,
    ownsDomain: async (domain) => {
      events.push(`${fake.id} ownsDomain ${domain}`);
      if (ownsError !== undefined) throw ownsError;
      return owns === undefined ? false : owns(domain);
    },
  };
  if (fake.id === "porkbun") {
    api.removeDsRecord = async (domain, keyTag) => {
      events.push(`porkbun removeDsRecord ${domain} ${keyTag}`);
      fake.dsRecords.set(
        domain,
        (fake.dsRecords.get(domain) ?? []).filter((r) => r.keyTag !== keyTag),
      );
    };
  }
  return api;
}

export interface ConnectProject {
  project: DomainProject;
  zones: FakeZoneRecords;
  dns: FakePublicDns;
  /** `ownsDomain` of these registrars throws (an account that cannot be checked). */
  ownsErrors: Map<OtherRegistrarId, Error>;
  /** A registrar account (as `project.other`), passed to every later run. */
  other(id: OtherRegistrarId, capabilities?: Partial<RegistrarCapabilities>): FakeRegistrar;
  /** A new run with the zone records, the public DNS and the registrars wired in. */
  run(options?: RunOptions): Promise<Run>;
}

/** A domain project for `connect`: the Cloudflare and registrar fakes plus records and DNS. */
export async function connectProject(
  options: Parameters<typeof domainProject>[0] = {},
): Promise<ConnectProject> {
  const project = await domainProject(options);
  const events = project.cf.events;
  const zones = new FakeZoneRecords(events, project.cf.zoneApi);
  const dns = new FakePublicDns(events);
  const fakes = new Map<OtherRegistrarId, FakeRegistrar>();
  const ownsErrors = new Map<OtherRegistrarId, Error>();
  return {
    project,
    zones,
    dns,
    ownsErrors,
    other(id, capabilities) {
      const fake = project.other(id, capabilities);
      fakes.set(id, fake);
      return fake;
    },
    async run(runOptions) {
      const run = await project.run(runOptions);
      run.deps.fetch = dns.fetch;
      run.services.zones = zones.api();
      run.services.registrars = Object.fromEntries(
        [...fakes].map(([id, fake]) => [id, connectApi(fake, events, ownsErrors.get(id))] as const),
      );
      return run;
    },
  };
}
