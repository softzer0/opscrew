import type { FetchLike } from "@opscrew/contracts";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { CLOUDFLARE_API } from "../client";

/**
 * A fake Cloudflare zone and account behind core's `fakeFetch`, with the Rulesets behaviour the
 * live spike of research R1–R3 observed: a missing entrypoint answers 404 with code 10003; `PUT`
 * creates it (or replaces every rule of an existing one); `POST …/rules` appends; `PATCH` keeps the
 * rule's id; deleting the last rule leaves an empty ruleset; deleting a ruleset answers 204; a
 * duplicate `ref` is refused (20023), as is an expression over 4,096 characters (20127) and a rule
 * beyond the zone plan's limit (a plan the fake does not know has the Free plan's 5 custom and 10
 * configuration rules). The zone details answer with its `plan.legacy_id`. The account holds the
 * Zero Trust organization and login methods.
 *
 * Origin TLS as feature 014's spike saw it: Origin CA certificates (15 years, `expires_on` as
 * `2041-10-16 23:53:00 +0000 UTC`, revoked ones still listed with `revoked_at`); client
 * certificates for per-hostname origin pulls (uploaded `pending_deployment`, listed so for
 * {@link FakeZone.certificatePendingReads} lists, then `active`; a deleted one stays listed as
 * `pending_deletion`); per-hostname settings, with their `cert_status`, that read
 * `pending_deployment` for {@link FakeZone.pendingReads} reads after each change, then `active`,
 * and 404 for a hostname without one; the zone's `min_tls_version`; and its DNS records.
 *
 * Workers as feature 016's spike saw them: the account's Workers, each with its versions (latest
 * first, the message as the `workers/message` annotation) and deployments (latest first; a `POST`
 * puts one version at 100% in front), 404 with code 10007 for a Worker the account does not have
 * (and 7003 for another account), and the account's Workers custom domains, filtered by `service`. Single redirect rules have the
 * configuration rules' limits. State is plain data for assertions.
 */

/** The fake zone's id. */
export const FAKE_ZONE_ID = "0123456789abcdef0123456789abcdef";
/** The fake account's id. */
export const FAKE_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";

export interface FakeRuleset {
  id: string;
  name: string;
  kind: "zone";
  phase: string;
  version: string;
  /** Rules as Cloudflare returns them. */
  rules: Record<string, unknown>[];
}

/** A request the fake received. */
export interface FakeZoneCall {
  method: string;
  path: string;
  body: unknown;
}

/** An Origin CA certificate as Cloudflare lists it. */
export interface FakeOriginCertificate {
  id: string;
  hostnames: string[];
  /** As Origin CA writes it: `2041-10-16 23:53:00 +0000 UTC`. */
  expires_on: string;
  /** A PEM block (not a real certificate). */
  certificate: string;
  revoked_at?: string;
}

/** A client certificate for per-hostname origin pulls, as Cloudflare lists it (no key kept). */
export interface FakeClientCertificate {
  id: string;
  certificate: string;
  /** As origin pulls write it: `2041-10-16T23:58:23Z`. */
  expires_on: string;
  status: string;
}

/** A hostname's per-hostname origin pull setting. */
export interface FakeHostnameAop {
  hostname: string;
  cert_id: string;
  enabled: boolean | null;
}

/** A version of a Worker. */
export interface FakeWorkerVersion {
  id: string;
  created_on: string;
  /** Listed as the `workers/message` annotation. */
  message?: string;
  source?: string;
}

/** A deployment of a Worker, as Cloudflare lists it. */
export interface FakeWorkerDeployment {
  id: string;
  created_on: string;
  source: string;
  strategy: "percentage";
  versions: { version_id: string; percentage: number }[];
  annotations?: Record<string, string>;
}

/** A Worker of the fake account: its versions and deployments, latest first. */
export interface FakeWorker {
  versions: FakeWorkerVersion[];
  deployments: FakeWorkerDeployment[];
}

/** A Workers custom domain, as Cloudflare lists it. */
export interface FakeWorkerDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

/** A one-shot failure of the next request matching `"METHOD /path"` (prefix). */
export interface FakeFault {
  match: string;
  reply: FakeReply;
  /** Carry the request out first: the change reaches Cloudflare, but its answer is `reply`. */
  applied?: boolean;
}

/** Rules per phase (custom, configuration) by plan, as Cloudflare enforces them. */
const LIMITS = new Map<string, [number, number]>([
  ["free", [5, 10]],
  ["pro", [20, 25]],
  ["business", [100, 50]],
  ["enterprise", [1000, 300]],
]);
const UPDATED = "2026-10-17T00:00:00.000000Z";

const ok = (result: unknown): FakeReply => ({
  body: { success: true, errors: [], messages: [], result },
});
const refuse = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

/** `reply` sent the way core's `fakeFetch` sends it (a timeout and a lost connection included). */
const answer = (reply: FakeReply, ...request: Parameters<FetchLike>) =>
  fakeFetch({ "/": reply }, { base: CLOUDFLARE_API }).fetch(...request);

/** A fake zone and account; send a `CloudflareClient`'s requests to its `fetch`. */
export class FakeZone {
  /** The zone's plan as `plan.legacy_id`; undefined leaves `plan` out of the zone details. */
  plan: string | undefined = "free";
  /** The zone's entrypoint rulesets by phase. */
  readonly entrypoints = new Map<string, FakeRuleset>();
  organization: { name: string; auth_domain: string } | undefined;
  readonly providers: { id: string; name: string; type: string }[] = [];
  /**
   * What the token may not read or change (HTTP 403): phases by name, `ssl` for origin
   * certificates and origin pulls, `settings` for the zone's settings, `dns` for its DNS records,
   * `workers` for the account's Workers and their custom domains.
   */
  readonly denied = new Set<string>();
  /** The account's Workers, by name. */
  readonly workers = new Map<string, FakeWorker>();
  /** The account's Workers custom domains. */
  readonly workerDomains: FakeWorkerDomain[] = [];
  readonly faults: FakeFault[] = [];
  readonly calls: FakeZoneCall[] = [];
  /** The zone's Origin CA certificates, revoked ones included. */
  readonly originCertificates: FakeOriginCertificate[] = [];
  /** The zone's client certificates for per-hostname origin pulls. */
  readonly clientCertificates: FakeClientCertificate[] = [];
  /** Per-hostname origin pull settings, by hostname. */
  readonly hostnameAop = new Map<string, FakeHostnameAop>();
  /**
   * How many reads of a hostname setting after its change show `pending_deployment` before
   * `active`; checked at each read, so lowering it lets Cloudflare finish (`Infinity`: never).
   */
  pendingReads = 1;
  /**
   * How many lists of the client certificates after an upload still show it
   * `pending_deployment` before `active`, checked at each list (`Infinity`: never).
   */
  certificatePendingReads = 0;
  /** The zone's `min_tls_version` setting. */
  minTls = { value: "1.0", editable: true };
  /** The zone's DNS records, as Cloudflare lists them. */
  readonly dnsRecords: Record<string, unknown>[] = [];
  /** When the fake issues certificates (they expire 15 years later). */
  now = new Date("2026-10-21T09:00:00Z");
  #ids = 0;
  /** Reads of each hostname setting since it last changed. */
  readonly #reads = new Map<string, number>();
  /** Lists of the client certificates since each one was uploaded, by id. */
  readonly #certificateReads = new Map<string, number>();

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).slice(CLOUDFLARE_API.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body });
    const at = this.faults.findIndex((f) => `${method} ${path}`.startsWith(f.match));
    const fault = at === -1 ? undefined : this.faults.splice(at, 1)[0];
    if (!fault || fault.applied) {
      const reply = this.#handle(method, path, body);
      if (!fault) return answer(reply, input, init);
    }
    return answer((fault as FakeFault).reply, input, init);
  };

  /** Puts a rule of the user's own into the phase (creating its entrypoint), as Cloudflare would. */
  seedRule(phase: string, rule: { description: string; expression: string; action: string }) {
    const ruleset = this.entrypoints.get(phase) ?? this.#newRuleset(phase);
    this.entrypoints.set(phase, ruleset);
    ruleset.rules.push(this.#stored(rule as Record<string, unknown>));
  }

  /** The rules of the phase without OpsCrew's, as JSON text (for byte-for-byte comparisons). */
  userRulesText(phase: string): string {
    const rules = this.entrypoints.get(phase)?.rules ?? [];
    return JSON.stringify(rules.filter((r) => !String(r.ref).startsWith("opscrew-")));
  }

  /** OpsCrew's rule in the phase, as stored. */
  opscrewRule(phase: string): Record<string, unknown> | undefined {
    return this.entrypoints.get(phase)?.rules.find((r) => String(r.ref).startsWith("opscrew-"));
  }

  /** The write requests received (everything but `GET`). */
  writes(): FakeZoneCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** Adds a DNS record to the zone, as Cloudflare would list it. */
  addDnsRecord(record: { type: string; name: string; proxied: boolean; comment?: string }) {
    this.dnsRecords.push({
      id: this.#id(),
      content: record.type === "CNAME" ? "target.example.net" : "203.0.113.10",
      ttl: 1,
      comment: null,
      ...record,
    });
  }

  #id(): string {
    this.#ids++;
    return this.#ids.toString(16).padStart(32, "0");
  }

  #newRuleset(phase: string): FakeRuleset {
    return { id: this.#id(), name: "default", kind: "zone", phase, version: "1", rules: [] };
  }

  #stored(rule: Record<string, unknown>, id = this.#id(), version = "1"): Record<string, unknown> {
    return {
      id,
      version,
      action: rule.action,
      ...(rule.action_parameters === undefined
        ? {}
        : { action_parameters: rule.action_parameters }),
      expression: rule.expression,
      description: rule.description ?? "",
      last_updated: UPDATED,
      ref: rule.ref ?? id,
      enabled: rule.enabled ?? true,
    };
  }

  #bump(ruleset: FakeRuleset) {
    ruleset.version = String(Number(ruleset.version) + 1);
  }

  /** Why Cloudflare refuses `rule` in `ruleset` (undefined: it does not). */
  #refusal(ruleset: FakeRuleset, rule: Record<string, unknown>, replacing?: string) {
    if (String(rule.expression).length > 4096) {
      return refuse(400, 20127, "expression exceeds the maximum length of 4096 characters");
    }
    const others = ruleset.rules.filter((r) => r.id !== replacing);
    if (rule.ref !== undefined && others.some((r) => r.ref === rule.ref)) {
      return refuse(400, 20023, "a rule with the same ref already exists");
    }
    const [custom, config] = LIMITS.get(this.plan ?? "") ?? [5, 10];
    const limit = ruleset.phase === "http_request_firewall_custom" ? custom : config;
    if (!replacing && others.length >= limit) {
      return refuse(400, 20003, "exceeded the maximum number of rules in the phase");
    }
    return undefined;
  }

  #handle(method: string, path: string, body: unknown): FakeReply {
    if (method === "GET" && path === `/zones/${FAKE_ZONE_ID}`) {
      return ok({
        id: FAKE_ZONE_ID,
        name: "example.com",
        status: "active",
        ...(this.plan ? { plan: { id: "0".repeat(32), legacy_id: this.plan } } : {}),
      });
    }
    const zone = `/zones/${FAKE_ZONE_ID}/rulesets`;
    const account = `/accounts/${FAKE_ACCOUNT_ID}/access`;
    const entry = new RegExp(`^${zone}/phases/([a-z_]+)/entrypoint$`).exec(path);
    if (entry?.[1]) return this.#entrypoint(method, entry[1], body);
    const rules = new RegExp(`^${zone}/([0-9a-f]+)/rules(?:/([0-9a-f]+))?$`).exec(path);
    if (rules?.[1]) return this.#rules(method, rules[1], rules[2], body);
    const ruleset = new RegExp(`^${zone}/([0-9a-f]+)$`).exec(path);
    if (ruleset?.[1] && method === "DELETE") return this.#deleteRuleset(ruleset[1]);
    if (path === `${account}/organizations`) return this.#organizations(method, body);
    if (path === `${account}/identity_providers`) return this.#providers(method, body);
    const url = new URL(path, "https://fake.invalid");
    const route = url.pathname;
    if (route.startsWith("/certificates")) return this.#originCa(method, route, url, body);
    const aop = `/zones/${FAKE_ZONE_ID}/origin_tls_client_auth/hostnames`;
    if (route.startsWith(aop)) return this.#aop(method, route.slice(aop.length), body);
    const workers = `/accounts/${FAKE_ACCOUNT_ID}/workers`;
    if (route.startsWith(workers)) {
      return this.#workers(method, route.slice(workers.length), url, body);
    }
    if (/^\/accounts\/[^/]+\/workers\//.test(route)) {
      return refuse(
        404,
        7003,
        "Could not route to the path, perhaps your object identifier is invalid?",
      );
    }
    if (route === `/zones/${FAKE_ZONE_ID}/settings/min_tls_version`) {
      return this.#minTls(method, body);
    }
    if (route === `/zones/${FAKE_ZONE_ID}/dns_records` && method === "GET") {
      if (this.denied.has("dns")) return refuse(403, 10000, "Authentication error");
      return {
        body: {
          success: true,
          errors: [],
          messages: [],
          result: this.dnsRecords,
          result_info: { page: 1, total_pages: 1 },
        },
      };
    }
    throw new Error(`fake zone: no route for ${method} ${path}`);
  }

  /** `now` plus 15 years, as an ISO time without milliseconds. */
  #expiry(): string {
    const at = new Date(this.now);
    at.setUTCFullYear(at.getUTCFullYear() + 15);
    return `${at.toISOString().slice(0, 19)}Z`;
  }

  /** A PEM block that is not a real certificate, unique to `id`. */
  #pem(id: string): string {
    const der = Buffer.from(`fake certificate ${id}`).toString("base64");
    return `-----BEGIN CERTIFICATE-----\n${der}\n-----END CERTIFICATE-----\n`;
  }

  #originCa(method: string, route: string, url: URL, body: unknown): FakeReply {
    if (this.denied.has("ssl")) return refuse(403, 10000, "Authentication error");
    if (method === "GET" && route === "/certificates") {
      if (url.searchParams.get("zone_id") !== FAKE_ZONE_ID) {
        return refuse(400, 1001, "zone_id is required");
      }
      return ok(this.originCertificates);
    }
    if (method === "POST" && route === "/certificates") {
      const sent = body as Record<string, unknown>;
      const hostnames = sent.hostnames as string[];
      if (
        sent.request_type !== "origin-ecc" ||
        sent.requested_validity !== 5475 ||
        !String(sent.csr).includes("BEGIN CERTIFICATE REQUEST") ||
        !Array.isArray(hostnames) ||
        hostnames.length === 0
      ) {
        return refuse(400, 1010, "invalid certificate request");
      }
      const id = this.#id();
      const expiry = this.#expiry();
      const certificate: FakeOriginCertificate = {
        id,
        hostnames: [...hostnames],
        expires_on: `${expiry.slice(0, 10)} ${expiry.slice(11, 19)} +0000 UTC`,
        certificate: this.#pem(id),
      };
      this.originCertificates.push(certificate);
      return ok({
        ...certificate,
        csr: sent.csr,
        request_type: "origin-ecc",
        requested_validity: 5475,
      });
    }
    const id = /^\/certificates\/([^/]+)$/.exec(route)?.[1];
    const certificate = this.originCertificates.find((c) => c.id === id && !c.revoked_at);
    if (method !== "DELETE" || !certificate) return refuse(404, 1004, "certificate not found");
    certificate.revoked_at = this.now.toISOString();
    return ok({ id: certificate.id, revoked_at: certificate.revoked_at });
  }

  /** `…/origin_tls_client_auth/hostnames` + `rest`. */
  #aop(method: string, rest: string, body: unknown): FakeReply {
    if (this.denied.has("ssl")) return refuse(403, 10000, "Authentication error");
    if (rest === "/certificates" && method === "GET") {
      return ok(
        this.clientCertificates.map((c) => {
          const reads = this.#certificateReads.get(c.id) ?? Number.POSITIVE_INFINITY;
          this.#certificateReads.set(c.id, reads + 1);
          return reads < this.certificatePendingReads ? { ...c, status: "pending_deployment" } : c;
        }),
      );
    }
    if (rest === "/certificates" && method === "POST") {
      const sent = body as Record<string, unknown>;
      if (
        !String(sent.certificate).includes("BEGIN CERTIFICATE") ||
        !String(sent.private_key).includes("PRIVATE KEY")
      ) {
        return refuse(400, 1406, "invalid certificate or key");
      }
      const id = this.#id();
      const stored = {
        id,
        certificate: String(sent.certificate),
        expires_on: this.#expiry(),
        status: "active",
      };
      this.clientCertificates.push(stored);
      this.#certificateReads.set(id, 0);
      return { status: 201, ...ok({ ...stored, status: "pending_deployment" }) };
    }
    const certificateId = /^\/certificates\/([^/]+)$/.exec(rest)?.[1];
    const usable = (id: string) =>
      this.clientCertificates.find((c) => c.id === id && c.status !== "pending_deletion");
    if (certificateId !== undefined && method === "DELETE") {
      const certificate = usable(certificateId);
      if (!certificate) return refuse(404, 1404, "certificate not found");
      // Listed as being deleted from then on (spike T1402: 200, `pending_deletion`).
      certificate.status = "pending_deletion";
      return ok({ id: certificateId, status: "pending_deletion" });
    }
    if (rest === "" && method === "PUT") {
      const config = (body as { config: FakeHostnameAop[] }).config;
      if (config.some((c) => !usable(c.cert_id))) return refuse(404, 1404, "certificate not found");
      for (const c of config) {
        this.hostnameAop.set(c.hostname, { ...c });
        this.#reads.set(c.hostname, 0);
      }
      return {
        status: 202,
        ...ok(config.map((c) => ({ ...c, status: "pending_deployment" }))),
      };
    }
    const hostname = /^\/([^/]+)$/.exec(rest)?.[1];
    const setting = hostname === undefined ? undefined : this.hostnameAop.get(hostname);
    if (method !== "GET" || hostname === undefined) {
      throw new Error(`fake zone: ${method} on origin pulls ${rest}`);
    }
    if (!setting) return refuse(404, 1404, "hostname not found");
    const reads = this.#reads.get(hostname) ?? Number.POSITIVE_INFINITY;
    this.#reads.set(hostname, reads + 1);
    const certificate = this.clientCertificates.find((c) => c.id === setting.cert_id);
    return ok({
      ...setting,
      cert_status: certificate?.status ?? "active",
      status: reads < this.pendingReads ? "pending_deployment" : "active",
    });
  }

  /** `/accounts/{id}/workers` + `rest`. */
  #workers(method: string, rest: string, url: URL, body: unknown): FakeReply {
    if (this.denied.has("workers")) return refuse(403, 10000, "Authentication error");
    if (rest === "/scripts" && method === "GET") {
      return ok([...this.workers.keys()].map((id) => ({ id })));
    }
    if (rest === "/domains" && method === "GET") {
      const service = url.searchParams.get("service");
      const domains = this.workerDomains
        .filter((d) => service === null || d.service === service)
        .map((d) => ({
          ...d,
          environment: "production",
          cert_id: `cert-${d.id}`,
          previews_enabled: false,
          enabled: true,
        }));
      // As Cloudflare answers this list: `errors` and `messages` are null, not empty arrays.
      return {
        body: {
          result: domains,
          success: true,
          errors: null,
          messages: null,
          result_info: {
            page: 1,
            per_page: domains.length,
            count: domains.length,
            total_count: domains.length,
          },
        },
      };
    }
    const script = /^\/scripts\/([^/]+)\/(versions|deployments)$/.exec(rest);
    if (!script?.[1]) throw new Error(`fake zone: ${method} on Workers ${rest}`);
    const worker = this.workers.get(decodeURIComponent(script[1]));
    if (!worker) return refuse(404, 10007, "This Worker does not exist on your account.");
    if (script[2] === "versions" && method === "GET") {
      return ok({
        items: worker.versions.map((v, i) => ({
          id: v.id,
          number: worker.versions.length - i,
          metadata: {
            created_on: v.created_on,
            modified_on: v.created_on,
            source: v.source ?? "wrangler",
            author_email: "dev@example.com",
          },
          annotations: v.message ? { "workers/message": v.message } : {},
        })),
      });
    }
    if (script[2] === "deployments" && method === "GET") {
      return ok({ deployments: worker.deployments });
    }
    if (script[2] !== "deployments" || method !== "POST") {
      throw new Error(`fake zone: ${method} on Workers ${rest}`);
    }
    const sent = body as Pick<FakeWorkerDeployment, "strategy" | "versions" | "annotations">;
    const total = sent.versions.reduce((sum, v) => sum + v.percentage, 0);
    if (
      sent.strategy !== "percentage" ||
      total !== 100 ||
      sent.versions.some((v) => !worker.versions.some((known) => known.id === v.version_id))
    ) {
      return refuse(400, 10021, "invalid deployment");
    }
    const deployment: FakeWorkerDeployment = {
      id: this.#id(),
      created_on: this.now.toISOString(),
      source: "api",
      strategy: "percentage",
      versions: sent.versions,
      ...(sent.annotations ? { annotations: sent.annotations } : {}),
    };
    worker.deployments.unshift(deployment);
    return ok(deployment);
  }

  #minTls(method: string, body: unknown): FakeReply {
    if (this.denied.has("settings")) return refuse(403, 10000, "Authentication error");
    if (method === "PATCH") {
      if (!this.minTls.editable) return refuse(400, 1007, "setting is not editable");
      this.minTls.value = String((body as { value: unknown }).value);
    }
    return ok({ id: "min_tls_version", ...this.minTls, modified_on: null });
  }

  #entrypoint(method: string, phase: string, body: unknown): FakeReply {
    if (this.denied.has(phase)) return refuse(403, 10000, "Authentication error");
    const existing = this.entrypoints.get(phase);
    if (method === "GET") {
      return existing
        ? ok(existing)
        : refuse(404, 10003, `could not find entrypoint ruleset in the '${phase}' phase`);
    }
    if (method !== "PUT") throw new Error(`fake zone: ${method} on an entrypoint`);
    const ruleset = existing ?? this.#newRuleset(phase);
    const sent = (body as { rules: Record<string, unknown>[] }).rules;
    const next: FakeRuleset = { ...ruleset, rules: [] };
    for (const rule of sent) {
      const refusal = this.#refusal(next, rule);
      if (refusal) return refusal;
      next.rules.push(this.#stored(rule));
    }
    if (existing) this.#bump(next);
    this.entrypoints.set(phase, next);
    return ok(next);
  }

  #find(rulesetId: string): FakeRuleset | undefined {
    return [...this.entrypoints.values()].find((r) => r.id === rulesetId);
  }

  #rules(method: string, rulesetId: string, ruleId: string | undefined, body: unknown): FakeReply {
    const ruleset = this.#find(rulesetId);
    if (!ruleset) return refuse(404, 10000, "ruleset not found");
    if (this.denied.has(ruleset.phase)) return refuse(403, 10000, "Authentication error");
    const rule = body as Record<string, unknown>;
    if (method === "POST" && !ruleId) {
      const refusal = this.#refusal(ruleset, rule);
      if (refusal) return refusal;
      ruleset.rules.push(this.#stored(rule));
      this.#bump(ruleset);
      return ok(ruleset);
    }
    const at = ruleset.rules.findIndex((r) => r.id === ruleId);
    if (at === -1) return refuse(404, 10000, "rule not found");
    if (method === "PATCH") {
      const refusal = this.#refusal(ruleset, rule, ruleId);
      if (refusal) return refusal;
      const old = ruleset.rules[at] as Record<string, unknown>;
      ruleset.rules[at] = this.#stored(rule, ruleId, String(Number(old.version) + 1));
      this.#bump(ruleset);
      return ok(ruleset);
    }
    if (method === "DELETE") {
      ruleset.rules.splice(at, 1);
      this.#bump(ruleset);
      return ok(ruleset);
    }
    throw new Error(`fake zone: ${method} on a rule`);
  }

  #deleteRuleset(rulesetId: string): FakeReply {
    const ruleset = this.#find(rulesetId);
    if (!ruleset) return refuse(404, 10000, "ruleset not found");
    this.entrypoints.delete(ruleset.phase);
    return { status: 204 };
  }

  #organizations(method: string, body: unknown): FakeReply {
    if (method === "GET") {
      return this.organization
        ? ok(this.organization)
        : refuse(404, 12130, "access.api.error.not_found: organization not found");
    }
    if (this.organization) return refuse(400, 12000, "organization already exists");
    const sent = body as { name: string; auth_domain: string };
    this.organization = { name: sent.name, auth_domain: sent.auth_domain };
    return ok(this.organization);
  }

  #providers(method: string, body: unknown): FakeReply {
    if (method === "GET") return ok(this.providers);
    const sent = body as { name: string; type: string };
    const provider = { id: this.#id(), name: sent.name, type: sent.type };
    this.providers.push(provider);
    return ok({ ...provider, config: {} });
  }
}
