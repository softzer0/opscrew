import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  DomainCheck,
  Money,
  RegisteredDomain,
  Registrar,
  RegistrationRequest,
  RegistrationState,
  RegistrationStatus,
} from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Requirements,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { OtherRegistrarId } from "../domain/registrars";
import type {
  DomainAccount,
  DomainServices,
  DomainZone,
  DomainZoneApi,
  ZoneDsRecord,
} from "../domain/types";
import { createTestPhaseDeps, ScriptedApprovalHandler, type TestPhaseDeps } from "./deps";
import { FakeRegistrar } from "./registrars";

/** The nameservers Cloudflare assigns to the fake's new zones. */
export const ZONE_NAMESERVERS: readonly string[] = [
  "kim.ns.cloudflare.com",
  "lee.ns.cloudflare.com",
];

/** The DS record the fake's zones publish once DNSSEC is on. */
export const ZONE_DS: ZoneDsRecord = {
  keyTag: 2371,
  algorithm: 13,
  digestType: 2,
  digest: "ABCDEF0123",
  ds: "shopapp.com. 3600 IN DS 2371 13 2 ABCDEF0123",
};

export const TOKEN = fakeSecret("cloudflare-token", "domain-tests");
export const usd = (amount: number): Money => ({ amount, currency: "USD" });

/** A standard, registrable `.com` at the given prices. */
export function buyable(domain: string, firstYear = 10.44, renewal = firstYear): DomainCheck {
  return {
    domain,
    registrable: true,
    tier: "standard",
    firstYear: usd(firstYear),
    renewal: usd(renewal),
  };
}

type Operation =
  | "accounts"
  | "check"
  | "suggest"
  | "status"
  | "register"
  | "getDomain"
  | "setAutoRenew"
  | "findZone"
  | "createZone"
  | "enableDnssec"
  | "dnssecEnabled"
  | "dsRecord"
  | "activationCheck"
  | "extension"
  | "sleep";

/**
 * Cloudflare as the domain commands see it: accounts, the registrar, zones and time. State lives
 * here (not in a run), so a second run against the same fake sees what the first one bought.
 * Every call is appended to `events` in order.
 */
export class FakeCloudflare {
  readonly events: string[] = [];
  accounts: DomainAccount[] = [{ id: "acc-1", name: "Shop" }];
  /** Live check answers by domain; names without an answer are left out of the response. */
  readonly checks = new Map<string, DomainCheck>();
  /** Replaces the answer of the n-th (1-based) check call for a domain. */
  checkOverride?: (domain: string, call: number) => DomainCheck | undefined;
  suggestions: DomainCheck[] = [];
  /** Registrations on the account, by domain. */
  readonly registrations = new Map<string, RegistrationStatus>();
  /** Requests behind the registrations (to build the registered domain). */
  private readonly requests = new Map<string, RegistrationRequest>();
  /** First status `register` answers with. */
  firstState: RegistrationState = "pending";
  /** States a pending registration moves to on each status call, in order. */
  progress: RegistrationState[] = ["in_progress", "succeeded"];
  /** Registrar messages per state. */
  messages: Partial<Record<RegistrationState, string>> = {};
  readonly domains = new Map<string, RegisteredDomain>();
  readonly zones = new Map<string, DomainZone>();
  /** What `activationCheck` answers. */
  activation: { requested: boolean; reason?: string } = { requested: true };
  readonly dnssec = new Set<string>();
  /** Extensions whose registrar settings require contact extensions (Cloudflare's lookup). */
  readonly contactTlds = new Set(["us", "uk", "ca"]);
  /** Extensions Cloudflare's lookup does not know (answers undefined). */
  readonly unknownTlds = new Set<string>();
  readonly registerCalls: { accountId: string; request: RegistrationRequest }[] = [];
  readonly autoRenewCalls: { domain: string; on: boolean }[] = [];
  /** Throws instead of performing the operation (n = 1-based call count of that operation). */
  failures: Partial<Record<Operation, (call: number) => Error | undefined>> = {};
  /** `register` creates the registration, then throws (the answer was lost). */
  loseRegisterResponse = false;
  /** Milliseconds slept so far (the fake clock). */
  time = 0;
  private readonly calls = new Map<Operation, number>();
  private readonly checkCalls = new Map<string, number>();

  private enter(operation: Operation, event?: string): void {
    const call = (this.calls.get(operation) ?? 0) + 1;
    this.calls.set(operation, call);
    if (event !== undefined) this.events.push(event);
    const error = this.failures[operation]?.(call);
    if (error !== undefined) throw error;
  }

  count(operation: Operation): number {
    return this.calls.get(operation) ?? 0;
  }

  /** Marks the domain as registered on the account (bought earlier or elsewhere). */
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

  private advance(domain: string): RegistrationStatus | undefined {
    const current = this.registrations.get(domain);
    if (current === undefined) return undefined;
    const terminal = current.state === "succeeded" || current.state === "failed";
    const nextState = terminal ? undefined : this.progress.shift();
    if (nextState !== undefined) this.setState(domain, nextState);
    const status = this.registrations.get(domain);
    return status === undefined ? undefined : { ...status };
  }

  private setState(domain: string, state: RegistrationState): void {
    const message = this.messages[state];
    this.registrations.set(domain, { domain, state, ...(message ? { message } : {}) });
    const request = this.requests.get(domain);
    if (state === "succeeded" && request !== undefined && !this.domains.has(domain)) {
      this.domains.set(domain, {
        domain,
        registrar: "cloudflare",
        createdAt: "2026-10-11T12:00:05Z",
        expiresAt: `${2026 + request.years}-10-11T12:00:05Z`,
        autoRenew: request.autoRenew,
        locked: true,
        privacy: request.privacy,
      });
    }
  }

  registrar(accountId: string): Registrar {
    return {
      id: "cloudflare",
      check: async (domains) => {
        this.enter("check", `check ${domains.join(",")}`);
        const answers: DomainCheck[] = [];
        for (const domain of domains) {
          const call = (this.checkCalls.get(domain) ?? 0) + 1;
          this.checkCalls.set(domain, call);
          const answer = this.checkOverride?.(domain, call) ?? this.checks.get(domain);
          if (answer !== undefined) answers.push({ ...answer });
        }
        return answers;
      },
      suggest: async (query) => {
        this.enter("suggest", `suggest ${query}`);
        return this.suggestions.map((s) => ({ ...s }));
      },
      registrationStatus: async (domain) => {
        this.enter("status", `status ${domain}`);
        return this.advance(domain);
      },
      register: async (request) => {
        this.enter("register", `register ${request.domain}`);
        this.registerCalls.push({ accountId, request: { ...request } });
        this.requests.set(request.domain, { ...request });
        this.setState(request.domain, this.firstState);
        if (this.loseRegisterResponse) throw new Error("socket hang up");
        return { ...(this.registrations.get(request.domain) as RegistrationStatus) };
      },
      getDomain: async (domain) => {
        this.enter("getDomain", `getDomain ${domain}`);
        const found = this.domains.get(domain);
        return found === undefined ? undefined : { ...found };
      },
      setAutoRenew: async (domain, on) => {
        this.enter("setAutoRenew", `setAutoRenew ${domain} ${on ? "on" : "off"}`);
        this.autoRenewCalls.push({ domain, on });
        const found = this.domains.get(domain);
        if (found === undefined) throw new Error(`no registration of ${domain}`);
        const updated = { ...found, autoRenew: on };
        this.domains.set(domain, updated);
        return { ...updated };
      },
    };
  }

  readonly zoneApi: DomainZoneApi = {
    findZone: async (name) => {
      this.enter("findZone", `findZone ${name}`);
      return this.zones.get(name);
    },
    createZone: async (accountId, name) => {
      this.enter("createZone", `createZone ${accountId} ${name}`);
      const zone = this.zones.get(name) ?? {
        id: `zone-${name}`,
        name,
        status: "pending",
        nameServers: [...ZONE_NAMESERVERS],
      };
      this.zones.set(name, zone);
      return { ...zone };
    },
    enableDnssec: async (zoneId) => {
      this.enter("enableDnssec", `enableDnssec ${zoneId}`);
      this.dnssec.add(zoneId);
    },
    dnssecEnabled: async (zoneId) => {
      this.enter("dnssecEnabled", `dnssecEnabled ${zoneId}`);
      return this.dnssec.has(zoneId);
    },
    dsRecord: async (zoneId) => {
      this.enter("dsRecord", `dsRecord ${zoneId}`);
      return this.dnssec.has(zoneId) ? { ...ZONE_DS } : undefined;
    },
    activationCheck: async (zoneId) => {
      this.enter("activationCheck", `activationCheck ${zoneId}`);
      return { ...this.activation };
    },
    // Buying never copies records; `connectProject` replaces these with a recording fake.
    listRecords: async () => [],
    createRecords: async (_zoneId, records) => records.length,
    scanRecords: async () => [],
  };

  services(): DomainServices {
    return {
      accounts: async () => {
        this.enter("accounts", "accounts");
        return this.accounts.map((a) => ({ ...a }));
      },
      registrar: (accountId) => this.registrar(accountId),
      extension: async (_accountId, tld) => {
        this.enter("extension", `extension ${tld}`);
        if (this.unknownTlds.has(tld)) return undefined;
        return { contactExtensionsRequired: this.contactTlds.has(tld) };
      },
      zones: this.zoneApi,
      sleep: async (ms) => {
        this.enter("sleep");
        this.time += ms;
      },
      now: () => this.time,
    };
  }
}

/** A valid plan for the domain tests (Hetzner, not deployed, no domain unless given). */
export function domainTestPlan(
  options: { domain?: string; deployed?: boolean; moving?: boolean } = {},
): DeployPlan {
  const target = {
    provider: "hetzner",
    mode: "vps-compose",
    location: "nbg1",
    serverType: "cpx22",
    backups: true,
  };
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    app: { name: "shop", port: 3000, env: [] },
    target,
    services: { postgres: false, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 7.09, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 7.09, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    dns: options.domain
      ? { provider: "cloudflare", domain: options.domain, proxied: true }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(options.deployed || options.moving
      ? { deployment: { lastApplyAt: "2026-10-01T11:00:00.000Z" } }
      : {}),
    ...(options.moving
      ? {
          retarget: {
            from: { target },
            step: "started",
            startedAt: "2026-10-12T09:00:00.000Z",
          },
        }
      : {}),
  });
}

export function testRequirements(domain?: string): Requirements {
  return {
    schemaVersion: 1,
    answeredAt: "2026-10-01T09:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 20, currency: "EUR" },
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    ...(domain === undefined ? { dnsProvider: "none" } : { domain, dnsProvider: "cloudflare" }),
    keepExternalServices: [],
  };
}

export type Answer = (
  request: ApprovalRequest,
) => boolean | { approved: boolean; confirmation?: string };

export interface DomainProject {
  root: string;
  cf: FakeCloudflare;
  /**
   * A fake Porkbun, Namecheap or GoDaddy account (created on first use, with the capabilities of
   * the real adapter unless given), passed to every later run as `services.registrars`.
   */
  other(
    id: OtherRegistrarId,
    capabilities?: ConstructorParameters<typeof FakeRegistrar>[2],
  ): FakeRegistrar;
  /** A new run against the same project and the same Cloudflare. */
  run(options?: RunOptions): Promise<Run>;
  /** Writes a purchase record as an earlier run would have. */
  writeRecord(record: Record<string, unknown>): Promise<string>;
}

export interface RunOptions {
  answer?: Answer;
  interactive?: boolean;
  token?: string | null;
  /** Wall clock of the run (default 2026-10-11T12:00:00Z, see `createTestPhaseDeps`). */
  now?: string;
  /** Approves like a blanket `--yes` would: approved, but without typing the domain. */
  assumeYes?: boolean;
}

/** Approves every request without a typed confirmation, as a blanket `--yes` would. */
class AssumeYesHandler extends ScriptedApprovalHandler {
  constructor(private readonly onRequest: (request: ApprovalRequest) => void) {
    super();
  }

  override async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    this.onRequest(request);
    return { approved: true, approver: "--yes flag", decidedAt: RUN_NOW };
  }
}

/** The default wall clock of a test run. */
export const RUN_NOW = "2026-10-11T12:00:00.000Z";

export interface Run {
  deps: TestPhaseDeps;
  handler: ScriptedApprovalHandler;
  services: DomainServices;
}

/** A temp project (plan and requirements when given) plus a fake Cloudflare shared by its runs. */
export async function domainProject(
  options: { plan?: DeployPlan; requirements?: Requirements } = {},
): Promise<DomainProject> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-domain-"));
  const cf = new FakeCloudflare();
  cf.checks.set("shopapp.com", buyable("shopapp.com"));
  const others = new Map<OtherRegistrarId, FakeRegistrar>();
  let keys = 0;
  if (options.plan) await writeArtifact("plan", join(root, "opscrew", "plan.yaml"), options.plan);
  if (options.requirements) {
    const file = join(root, "opscrew", "requirements.yaml");
    await writeArtifact("requirements", file, options.requirements);
  }
  const run = async (runOptions: RunOptions = {}): Promise<Run> => {
    const answer = runOptions.answer ?? (() => true);
    const handler =
      runOptions.assumeYes === true
        ? new AssumeYesHandler((request) => cf.events.push(`approval ${request.kind}`))
        : new ScriptedApprovalHandler((request) => {
            cf.events.push(`approval ${request.kind}`);
            return answer(request);
          });
    const token = runOptions.token === undefined ? TOKEN : runOptions.token;
    const now = new Date(runOptions.now ?? RUN_NOW);
    const deps = await createTestPhaseDeps({
      root,
      env: {
        OPSCREW_HOME: join(root, ".home-opscrew"),
        ...(token === null ? {} : { CLOUDFLARE_API_TOKEN: token }),
      },
      approvalHandler: handler,
      interactive: runOptions.interactive ?? true,
      clock: { now: () => now },
    });
    const services: DomainServices = {
      ...cf.services(),
      // idempotency keys: deterministic, one per purchase record
      randomUUID: () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`,
    };
    if (others.size > 0) {
      services.registrars = Object.fromEntries(
        [...others].map(([id, fake]) => [id, fake.api()] as const),
      );
    }
    return { deps, handler, services };
  };
  return {
    root,
    cf,
    other(id, capabilities) {
      let fake = others.get(id);
      if (fake === undefined) {
        fake = new FakeRegistrar(id, cf.events, capabilities);
        others.set(id, fake);
      }
      return fake;
    },
    run,
    async writeRecord(record) {
      const { deps } = await run();
      const file = join(deps.paths.projectHomeDir, "domain-purchase.json");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(record));
      return file;
    },
  };
}

/** Everything a user or the audit log could see from a run, for leak checks. */
export function visibleText(deps: TestPhaseDeps, error?: unknown): string {
  const errorParts =
    error instanceof Error
      ? [error.message, (error as { hint?: string }).hint ?? ""]
      : error === undefined
        ? []
        : [String(error)];
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify((deps.approvalHandler as ScriptedApprovalHandler).requests),
    ...errorParts,
  ].join("\n");
}
