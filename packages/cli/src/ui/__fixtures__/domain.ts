/**
 * A fake Cloudflare (accounts, registrar, extensions, zones) and a temp project for the
 * `opscrew domain` command tests. Nothing here reaches the network. For tests only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DomainAccount, DomainServices } from "@opscrew/agents";
import type {
  DomainCheck,
  Money,
  RegisteredDomain,
  Registrar,
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

/**
 * Cloudflare as the domain commands see it. A purchase succeeds at once; every call is appended
 * to `events`.
 */
export class FakeCloudflare {
  readonly events: string[] = [];
  accounts: DomainAccount[] = [{ id: "acc-1", name: "Shop" }];
  readonly checks = new Map<string, DomainCheck>();
  suggestions: DomainCheck[] = [];
  readonly registrations = new Map<string, RegistrationStatus>();
  readonly domains = new Map<string, RegisteredDomain>();
  readonly zones = new Map<string, { id: string; name: string }>();
  readonly registerCalls: { accountId: string; request: RegistrationRequest }[] = [];
  readonly autoRenewCalls: { domain: string; on: boolean }[] = [];
  /** Thrown by `check` instead of answering (for the error and redaction tests). */
  checkError?: Error;

  constructor() {
    this.checks.set("shopapp.com", buyable("shopapp.com"));
  }

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
    return {
      accounts: async () => {
        this.events.push("accounts");
        return this.accounts.map((a) => ({ ...a }));
      },
      registrar: (accountId) => this.registrar(accountId),
      extension: async (_accountId, tld) => ({
        contactExtensionsRequired: ["us", "uk", "ca"].includes(tld),
      }),
      zones: {
        findZone: async (name) => this.zones.get(name),
        createZone: async (_accountId, name) => {
          const zone = this.zones.get(name) ?? { id: `zone-${name}`, name };
          this.zones.set(name, zone);
          return zone;
        },
        enableDnssec: async () => {},
        dnssecEnabled: async () => true,
      },
      sleep: async () => {},
      now: () => 0,
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
        { interactive: options.interactive ?? false, services: { prompts } },
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
