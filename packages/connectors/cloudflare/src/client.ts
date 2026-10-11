import type { CredentialCheck, FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Permissions OpsCrew asks for, named as in the Cloudflare dashboard token builder. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  "Zone → Zone → Read",
  "Zone → DNS → Edit",
  "Zone → Config Rules → Edit",
  "Zone → Zone WAF → Edit",
] as const;

/** Rule phases OpsCrew may manage; it never takes over a phase the user already uses. */
export type ManagedRulesetPhase = "http_config_settings" | "http_request_firewall_custom";

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
}

export interface CloudflareIpRanges {
  ipv4: string[];
  ipv6: string[];
}

export interface CloudflareClientOptions {
  token?: string;
  fetch: FetchLike;
  baseUrl?: string;
  /** Sleep used between retries (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  version?: string;
}

const Envelope = z.looseObject({
  success: z.boolean(),
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string() })).default([]),
  result: z.unknown().optional(),
  result_info: z
    .looseObject({ page: z.number().optional(), total_pages: z.number().optional() })
    .optional(),
});

const ZoneSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  name_servers: z.array(z.string()).default([]),
});

const RecordSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().default(""),
  proxied: z.boolean().optional(),
  ttl: z.number(),
});

const RulesetSchema = z.looseObject({ rules: z.array(z.unknown()).default([]) });

const IpsSchema = z.looseObject({
  ipv4_cidrs: z.array(z.string()),
  ipv6_cidrs: z.array(z.string()),
});

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_SERVER_RETRIES = 2;

/**
 * Lists the domain and each parent that could be the Cloudflare zone, most specific first:
 * `app.example.co.uk` → `app.example.co.uk`, `example.co.uk`, `co.uk`. Single labels are skipped.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

function permissionHint(): string {
  return `Create a token at https://dash.cloudflare.com/profile/api-tokens with: ${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}; then set CLOUDFLARE_API_TOKEN.`;
}

/** Read-only Cloudflare API client. DNS changes are made through HCL and the approval gate. */
export class CloudflareClient {
  readonly #token: string | undefined;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;

  constructor(options: CloudflareClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? CLOUDFLARE_API).replace(/\/$/, "");
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
  }

  /** Raw request returning the parsed envelope and HTTP status. Retries 429 and 5xx. */
  async #request(
    path: string,
    auth = true,
  ): Promise<{ status: number; body: z.infer<typeof Envelope> }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.#userAgent,
    };
    if (auth) {
      if (!this.#token) {
        throw new OpsCrewError("CREDENTIALS_MISSING", "No Cloudflare API token is set.", {
          hint: permissionHint(),
        });
      }
      headers.Authorization = `Bearer ${this.#token}`;
    }
    let rateLimited = 0;
    let serverErrors = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, { headers });
      } catch (error) {
        if (serverErrors < MAX_SERVER_RETRIES) {
          serverErrors++;
          await this.#sleep(1000 * 2 ** serverErrors);
          continue;
        }
        throw new OpsCrewError("PROVIDER_ERROR", "Could not reach the Cloudflare API.", {
          hint: "Check your internet connection and try again.",
          cause: error,
        });
      }
      if (response.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
        rateLimited++;
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.#sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 60) * 1000
            : 1000 * 2 ** rateLimited,
        );
        continue;
      }
      if (response.status >= 500 && serverErrors < MAX_SERVER_RETRIES) {
        serverErrors++;
        await this.#sleep(1000 * 2 ** serverErrors);
        continue;
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = { success: false, errors: [{ message: `HTTP ${response.status}` }] };
      }
      const parsed = Envelope.safeParse(json);
      const body = parsed.success
        ? parsed.data
        : {
            success: false,
            errors: [{ message: `Unexpected response (HTTP ${response.status})` }],
          };
      return { status: response.status, body };
    }
  }

  #fail(status: number, body: z.infer<typeof Envelope>, what: string): never {
    const detail = body.errors.map((e) => e.message).join("; ") || `HTTP ${status}`;
    if (status === 401 || status === 403) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Cloudflare refused the request to ${what}: ${detail}.`,
        { hint: permissionHint() },
      );
    }
    throw new OpsCrewError("PROVIDER_ERROR", `Cloudflare could not ${what}: ${detail}.`, {
      hint: "Try again in a minute; if it keeps failing, check https://www.cloudflarestatus.com.",
    });
  }

  async #get<T>(path: string, schema: z.ZodType<T>, what: string, auth = true): Promise<T> {
    const { status, body } = await this.#request(path, auth);
    if (!body.success || status >= 400) this.#fail(status, body, what);
    const result = schema.safeParse(body.result);
    if (!result.success) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Cloudflare returned an unexpected answer when trying to ${what}.`,
      );
    }
    return result.data;
  }

  /** Checks the token works. Falls back to listing zones for account-owned tokens. */
  async verifyToken(): Promise<CredentialCheck> {
    if (!this.#token) {
      return { ok: false, message: "CLOUDFLARE_API_TOKEN is not set." };
    }
    const { status, body } = await this.#request("/user/tokens/verify");
    const result = z.looseObject({ status: z.string() }).safeParse(body.result);
    if (body.success && result.success && result.data.status === "active") {
      return { ok: true, identity: "user API token", message: "The Cloudflare token is active." };
    }
    const zones = await this.#request("/zones?per_page=1");
    if (zones.body.success && zones.status < 400) {
      return {
        ok: true,
        identity: "account API token",
        message: "The Cloudflare token can read zones.",
      };
    }
    if (status === 401 || status === 403 || zones.status === 401 || zones.status === 403) {
      return { ok: false, message: `The Cloudflare token was rejected. ${permissionHint()}` };
    }
    return {
      ok: false,
      message: `Cloudflare could not verify the token: ${body.errors.map((e) => e.message).join("; ") || `HTTP ${status}`}.`,
    };
  }

  /** The zone that contains `domain` (tries the domain itself, then each parent), if any. */
  async findZone(domain: string): Promise<CloudflareZone | undefined> {
    for (const candidate of zoneCandidates(domain)) {
      const zones = await this.#get(
        `/zones?name=${encodeURIComponent(candidate)}&per_page=1`,
        z.array(ZoneSchema),
        `look up the zone ${candidate}`,
      );
      const zone = zones[0];
      if (zone) {
        return {
          id: zone.id,
          name: zone.name,
          status: zone.status,
          nameServers: zone.name_servers,
        };
      }
    }
    return undefined;
  }

  /** DNS records of a zone, optionally filtered by exact name and type. Follows pagination. */
  async listDnsRecords(
    zoneId: string,
    filter: { name?: string; type?: string } = {},
  ): Promise<CloudflareDnsRecord[]> {
    const records: CloudflareDnsRecord[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "100" });
      if (filter.name) query.set("name", filter.name);
      if (filter.type) query.set("type", filter.type);
      const { status, body } = await this.#request(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`,
      );
      if (!body.success || status >= 400) this.#fail(status, body, "list DNS records");
      const parsed = z.array(RecordSchema).safeParse(body.result);
      if (!parsed.success)
        throw new OpsCrewError("PROVIDER_ERROR", "Cloudflare returned unexpected DNS records.");
      for (const r of parsed.data) {
        records.push({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
          ttl: r.ttl,
          ...(r.proxied === undefined ? {} : { proxied: r.proxied }),
        });
      }
      const totalPages = body.result_info?.total_pages ?? 1;
      if (page >= totalPages) return records;
    }
  }

  /** True when the zone already has its own rules in this phase (OpsCrew then leaves it alone). */
  async hasEntrypointRuleset(zoneId: string, phase: ManagedRulesetPhase): Promise<boolean> {
    const { status, body } = await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${phase}/entrypoint`,
    );
    if (status === 404) return false;
    if (!body.success || status >= 400) this.#fail(status, body, `read the ${phase} rules`);
    const ruleset = RulesetSchema.safeParse(body.result);
    return ruleset.success && ruleset.data.rules.length > 0;
  }

  /** Cloudflare's published edge IP ranges (public endpoint, no token needed). */
  async getIpRanges(): Promise<CloudflareIpRanges> {
    const ips = await this.#get("/ips", IpsSchema, "read its IP ranges", false);
    return { ipv4: ips.ipv4_cidrs, ipv6: ips.ipv6_cidrs };
  }
}
